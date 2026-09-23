import {
  ARTIFACT_SENSITIVITIES,
  challengeRequestSchema,
  pairRequestSchema,
  REMOTE_LIMITS,
  REMOTE_MIN_PROTOCOL_VERSION,
  rotateRequestSchema,
  sessionProofMessage,
  sessionRequestSchema,
  type ArtifactSensitivity,
} from '@acc/shared';
import type { z } from 'zod';
import { bearer, CHALLENGE_TTL_MS, issueSession, newNodeId, readSession, secretHash, SESSION_TTL_MS, verifyNodeSignature } from '../auth/node.js';
import type { Env } from '../env.js';
import { clientIp, HttpError, isoIn, json, log, randomToken, readJson } from '../http.js';
import { CloudStore, type NodeRecord } from '../store.js';

/**
 * The relay hostname: pairing, challenge-response sessions, the node
 * WebSocket and uploads. Nothing here serves the dashboard or reveals task
 * data without a valid node session (docs/systems/cloud-control.md §Nodes).
 */

const JSON_LIMIT = 16 * 1024;

async function limited(limiter: RateLimit, key: string): Promise<void> {
  const { success } = await limiter.limit({ key });
  if (!success) throw new HttpError(429, 'RATE_LIMITED', 'Too many attempts. Wait a minute and try again.');
}

async function body<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await readJson(request, JSON_LIMIT));
  if (!parsed.success) throw new HttpError(400, 'REMOTE_INVALID', parsed.error.issues[0]?.message ?? 'Invalid request');
  return parsed.data;
}

/** A valid session for a node that still exists, is not revoked and holds the same key version. */
async function sessionNode(request: Request, env: Env, store: CloudStore): Promise<NodeRecord> {
  const session = await readSession(env, bearer(request));
  if (!session) throw new HttpError(401, 'UNAUTHORIZED', 'Node session missing, invalid or expired.');
  const node = await store.node(session.nodeId);
  if (!node) throw new HttpError(404, 'NODE_NOT_FOUND', 'Unknown node.');
  if (node.revokedAt) throw new HttpError(403, 'NODE_REVOKED', 'This node was revoked.');
  if (node.keyVersion !== session.keyVersion) throw new HttpError(401, 'UNAUTHORIZED', 'Node key was rotated; start a new session.');
  return node;
}

function hub(env: Env) {
  return env.HUB.get(env.HUB.idFromName('workspace'));
}

export async function handleRelay(request: Request, env: Env, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const store = new CloudStore(env.DB);
  const ip = clientIp(request);
  const path = url.pathname;

  if (request.method === 'POST' && path === '/node/v1/pair') {
    await limited(env.PAIRING_LIMITER, `pair:${ip}`);
    const input = await body(request, pairRequestSchema);
    const nodeId = newNodeId();
    const token = await store.consumePairingToken(await secretHash(input.token), nodeId);
    if (!token) {
      await store.audit({ actor: `ip:${ip}`, action: 'node.pair', result: 'refused', detail: { reason: 'invalid, used or expired code' }, requestId });
      throw new HttpError(401, 'UNAUTHORIZED', 'Pairing code is invalid, used or expired.');
    }
    await store.createNode({ id: nodeId, label: input.label, os: input.os, appVersion: input.appVersion, protocolVersion: input.protocolVersion, publicKey: input.publicKey, pairedBy: token.createdBy });
    await store.audit({ actor: token.createdBy, action: 'node.pair', nodeId, target: input.label, result: 'ok', requestId });
    log('info', 'node.paired', { nodeId, requestId });
    await hub(env).announceNode(nodeId);
    return json({ nodeId, label: input.label }, 201);
  }

  if (request.method === 'POST' && path === '/node/v1/challenge') {
    await limited(env.AUTH_LIMITER, `challenge:${ip}`);
    const { nodeId } = await body(request, challengeRequestSchema);
    const node = await store.node(nodeId);
    if (!node) throw new HttpError(404, 'NODE_NOT_FOUND', 'Unknown node.');
    if (node.revokedAt) throw new HttpError(403, 'NODE_REVOKED', 'This node was revoked.');
    const nonce = randomToken(32);
    const expiresAt = isoIn(CHALLENGE_TTL_MS);
    await store.createChallenge(await secretHash(nonce), nodeId, expiresAt);
    return json({ nonce, expiresAt });
  }

  if (request.method === 'POST' && path === '/node/v1/session') {
    await limited(env.AUTH_LIMITER, `session:${ip}`);
    const input = await body(request, sessionRequestSchema);
    const node = await store.node(input.nodeId);
    if (!node) throw new HttpError(404, 'NODE_NOT_FOUND', 'Unknown node.');
    if (node.revokedAt) throw new HttpError(403, 'NODE_REVOKED', 'This node was revoked.');
    if (input.protocolVersion < REMOTE_MIN_PROTOCOL_VERSION) throw new HttpError(426, 'NODE_UPDATE_REQUIRED', `Update the Control Center: protocol ${REMOTE_MIN_PROTOCOL_VERSION} or newer is required.`);
    // The nonce is spent before the signature is checked: a failed attempt cannot be retried with it.
    const fresh = await store.consumeChallenge(await secretHash(input.nonce), input.nodeId);
    const valid = fresh && (await verifyNodeSignature(node.publicKey, sessionProofMessage('session', input.nodeId, input.nonce), input.signature));
    if (!valid) {
      await store.audit({ actor: `ip:${ip}`, action: 'node.session', nodeId: input.nodeId, result: 'refused', detail: { reason: fresh ? 'bad signature' : 'unknown, used or expired challenge' }, requestId });
      throw new HttpError(401, 'UNAUTHORIZED', 'Challenge failed.');
    }
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const session = await issueSession(env, { nodeId: node.id, keyVersion: node.keyVersion, protocolVersion: input.protocolVersion, expiresAt });
    return json({ session, expiresAt: new Date(expiresAt).toISOString(), protocolVersion: input.protocolVersion });
  }

  if (request.method === 'POST' && path === '/node/v1/rotate') {
    await limited(env.AUTH_LIMITER, `rotate:${ip}`);
    const node = await sessionNode(request, env, store);
    const input = await body(request, rotateRequestSchema);
    const fresh = await store.consumeChallenge(await secretHash(input.nonce), node.id);
    if (!fresh || !(await verifyNodeSignature(input.publicKey, sessionProofMessage('rotate', node.id, input.nonce), input.signature))) {
      await store.audit({ actor: `node:${node.id}`, action: 'node.rotate', nodeId: node.id, result: 'refused', requestId });
      throw new HttpError(401, 'UNAUTHORIZED', 'Rotation refused: the new key did not sign a fresh challenge.');
    }
    const keyVersion = await store.rotateKey(node.id, input.publicKey);
    await store.audit({ actor: `node:${node.id}`, action: 'node.rotate', nodeId: node.id, result: 'ok', detail: { keyVersion }, requestId });
    await hub(env).keyRotated(node.id);
    return json({ nodeId: node.id, label: node.label });
  }

  if (request.method === 'GET' && path === '/node/v1/connect') {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'UPGRADE_REQUIRED', 'WebSocket upgrade required.');
    const session = await readSession(env, bearer(request));
    if (!session) throw new HttpError(401, 'UNAUTHORIZED', 'Node session missing, invalid or expired.');
    const node = await store.node(session.nodeId);
    if (!node || node.revokedAt) throw new HttpError(403, 'NODE_REVOKED', 'This node was revoked.');
    if (node.keyVersion !== session.keyVersion) throw new HttpError(401, 'UNAUTHORIZED', 'Node key was rotated; start a new session.');
    const forward = new Request('https://hub/connect/node', { headers: { upgrade: 'websocket', 'x-acc-node-id': node.id, 'x-acc-protocol': String(session.protocolVersion) } });
    return hub(env).fetch(forward);
  }

  const artifact = /^\/node\/v1\/artifacts\/([A-Za-z0-9._:-]{1,200})$/.exec(path);
  if (request.method === 'PUT' && artifact) return upload(request, env, store, { kind: 'artifact', id: artifact[1]! });
  const chunk = /^\/node\/v1\/logs\/([A-Za-z0-9._:-]{1,200})\/(\d{1,6})$/.exec(path);
  if (request.method === 'PUT' && chunk) return upload(request, env, store, { kind: 'log', id: chunk[1]!, index: Number(chunk[2]) });

  throw new HttpError(404, 'NOT_FOUND', 'Not found');
}

/**
 * Store one approved object. R2 verifies the declared SHA-256 while it writes
 * the streamed body; keys are immutable (they carry the hash), the bucket is
 * private, and downloads go through the authenticated control hostname only.
 */
async function upload(request: Request, env: Env, store: CloudStore, target: { kind: 'artifact'; id: string } | { kind: 'log'; id: string; index: number }): Promise<Response> {
  const node = await sessionNode(request, env, store);
  const sha256 = request.headers.get('x-acc-sha256') ?? '';
  const taskId = request.headers.get('x-acc-task-id') ?? '';
  const size = Number(request.headers.get('content-length') ?? 'NaN');
  const limit = target.kind === 'artifact' ? REMOTE_LIMITS.artifactBytes : REMOTE_LIMITS.logChunkBytes;
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new HttpError(400, 'REMOTE_INVALID', 'x-acc-sha256 must be a SHA-256 hex digest.');
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId)) throw new HttpError(400, 'REMOTE_INVALID', 'x-acc-task-id is required.');
  if (!Number.isInteger(size) || size < 0) throw new HttpError(411, 'LENGTH_REQUIRED', 'Content-Length is required.');
  if (size > limit) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', `Objects above ${limit} bytes stay on the node.`);
  if (!request.body) throw new HttpError(400, 'REMOTE_INVALID', 'Empty upload.');
  const contentType = (request.headers.get('content-type') ?? 'application/octet-stream').slice(0, 100);

  if (target.kind === 'artifact') {
    const sensitivity = (request.headers.get('x-acc-sensitivity') ?? '') as ArtifactSensitivity;
    if (!ARTIFACT_SENSITIVITIES.includes(sensitivity) || sensitivity === 'local_only') throw new HttpError(403, 'REMOTE_FORBIDDEN', 'Local-only artifacts are never uploaded.');
    const name = decodeURIComponent(request.headers.get('x-acc-name') ?? 'artifact').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 200);
    const key = `nodes/${node.id}/artifacts/${target.id}/${sha256}`;
    try {
      await env.ARTIFACTS.put(key, request.body, { sha256, httpMetadata: { contentType }, customMetadata: { nodeId: node.id, taskId } });
    } catch (error) {
      // sha256 null: a failed re-upload must not overwrite the hash of the copy that is still stored.
      await store.upsertManifest(node.id, { artifactId: target.id, taskId, name, mime: contentType, size, sha256: null, sensitivity, status: 'failed', error: 'hash mismatch or storage error' });
      log('warn', 'artifact.upload.failed', { nodeId: node.id, artifactId: target.id, message: (error as Error).message });
      throw new HttpError(422, 'HASH_MISMATCH', 'The upload did not match its SHA-256 or could not be stored.');
    }
    const previousKey = (await store.manifest(node.id, target.id))?.r2_key ?? null;
    await store.upsertManifest(node.id, { artifactId: target.id, taskId, name, mime: contentType, size, sha256, sensitivity, status: 'uploaded', error: null, r2Key: key });
    if (previousKey && previousKey !== key) await env.ARTIFACTS.delete(previousKey); // the replaced copy is not left behind
    return json({ ok: true, key: `${target.id}/${sha256.slice(0, 12)}` }, 201);
  }

  const firstSeq = Number(request.headers.get('x-acc-first-seq'));
  const lastSeq = Number(request.headers.get('x-acc-last-seq'));
  if (!Number.isInteger(firstSeq) || !Number.isInteger(lastSeq) || lastSeq < firstSeq) throw new HttpError(400, 'REMOTE_INVALID', 'x-acc-first-seq and x-acc-last-seq are required.');
  const key = `nodes/${node.id}/logs/${target.id}/${String(target.index).padStart(6, '0')}-${sha256}`;
  try {
    await env.ARTIFACTS.put(key, request.body, { sha256, httpMetadata: { contentType: 'text/plain; charset=utf-8' }, customMetadata: { nodeId: node.id, taskId } });
  } catch {
    throw new HttpError(422, 'HASH_MISMATCH', 'The upload did not match its SHA-256 or could not be stored.');
  }
  const previousKey = await store.logChunkKey(node.id, target.id, target.index);
  await store.addLogChunk(node.id, { executionId: target.id, taskId, chunkIndex: target.index, firstSeq, lastSeq, sha256, size, r2Key: key });
  if (previousKey && previousKey !== key) await env.ARTIFACTS.delete(previousKey);
  return json({ ok: true }, 201);
}
