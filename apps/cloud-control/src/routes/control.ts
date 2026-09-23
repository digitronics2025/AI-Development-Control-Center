import {
  approvalBindingHash,
  commandPayloadHash,
  matchRemoteOperation,
  PAIRING_TOKEN_PREFIX,
  QUEUED_TASK_TTL_SECONDS,
  REMOTE_LIMITS,
  REMOTE_MIN_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  validateRemoteBody,
  type CloudSession,
  type CommandPrecondition,
  type RemoteCommand,
  type RemoteOperation,
} from '@acc/shared';
import { verifyAccess, type AccessIdentity } from '../auth/access.js';
import { PAIRING_TTL_MS, secretHash } from '../auth/node.js';
import type { Env } from '../env.js';
import type { CommandWait, RpcReply } from '../hub.js';
import { clientIp, DASHBOARD_CSP, fromBase64url, HttpError, isoIn, json, log, randomToken, readJson } from '../http.js';
import { offlineRead } from '../offline.js';
import { CloudStore, commandView } from '../store.js';

/**
 * The control hostname: the dashboard, the cloud API and browser realtime,
 * all behind Cloudflare Access and verified again here
 * (docs/systems/cloud-control.md §People).
 */

const CLOUD_JSON_LIMIT = 16 * 1024;
/** Terminal access needs a sign-in no older than this. */
const RECENT_SIGN_IN_S = 60 * 60;

const REFUSAL_STATUS: Record<string, number> = {
  REMOTE_COMMAND_EXPIRED: 410,
  REMOTE_CONFLICT: 409,
  REMOTE_FORBIDDEN: 403,
  REMOTE_INVALID: 400,
  REMOTE_INTERRUPTED: 409,
  REMOTE_UNAVAILABLE: 503,
  NODE_REVOKED: 403,
};

function hub(env: Env) {
  return env.HUB.get(env.HUB.idFromName('workspace'));
}

/** Browsers send Origin on every state-changing request; anything but our own origin is refused. */
function assertSameOrigin(request: Request, url: URL): void {
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'BAD_ORIGIN', 'Cross-origin requests are not allowed.');
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'BAD_ORIGIN', 'Cross-site requests are not allowed.');
}

export async function handleControl(request: Request, env: Env, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  let identity: AccessIdentity;
  try {
    identity = await verifyAccess(request, env);
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      const { success } = await env.AUTH_LIMITER.limit({ key: `access:${clientIp(request)}` });
      if (!success) throw new HttpError(429, 'RATE_LIMITED', 'Too many unauthenticated requests.');
    }
    throw error;
  }
  const path = url.pathname;

  if (path === '/ws') {
    assertSameOrigin(request, url);
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, 'UPGRADE_REQUIRED', 'WebSocket upgrade required.');
    return hub(env).fetch(new Request('https://hub/connect/browser', { headers: { upgrade: 'websocket', 'x-acc-user': identity.email } }));
  }

  if (path.startsWith('/api/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') assertSameOrigin(request, url);
    if (path.startsWith('/api/cloud/')) return cloudApi(request, env, url, identity, requestId);
    return proxy(request, env, url, identity, requestId);
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
  const asset = await env.ASSETS.fetch(request);
  const type = asset.headers.get('content-type') ?? '';
  if (type.includes('text/html')) {
    const r = new Response(asset.body, asset);
    r.headers.set('content-security-policy', DASHBOARD_CSP);
    r.headers.set('x-frame-options', 'DENY');
    r.headers.set('cache-control', 'no-store');
    return r;
  }
  return asset;
}

// ---------------------------------------------------------------------------
// Cloud-native API: session, nodes, pairing, commands, audit, artifacts
// ---------------------------------------------------------------------------

async function cloudApi(request: Request, env: Env, url: URL, identity: AccessIdentity, requestId: string): Promise<Response> {
  const store = new CloudStore(env.DB);
  const path = url.pathname;
  const m = (re: RegExp) => re.exec(path);

  if (request.method === 'GET' && path === '/api/cloud/session') {
    const session: CloudSession = { user: { email: identity.email }, relayUrl: relayOrigin(env, url), protocolVersion: REMOTE_PROTOCOL_VERSION, minProtocolVersion: REMOTE_MIN_PROTOCOL_VERSION, environment: env.ENVIRONMENT, nodes: await store.listNodes() };
    return json(session);
  }
  if (request.method === 'GET' && path === '/api/cloud/nodes') return json(await store.listNodes());
  if (request.method === 'GET' && path === '/api/cloud/health') return json(await health(env));

  let match = m(/^\/api\/cloud\/nodes\/(node_[A-Za-z0-9_-]{16,64})$/);
  if (request.method === 'PATCH' && match) {
    const body = (await readJson(request, CLOUD_JSON_LIMIT)) as { label?: unknown } | undefined;
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    if (!label || label.length > 80) throw new HttpError(400, 'VALIDATION', 'A name of 1 to 80 characters is required.');
    const node = await store.node(match[1]!);
    if (!node) throw new HttpError(404, 'NODE_NOT_FOUND', 'Unknown node.');
    await store.renameNode(node.id, label);
    await store.audit({ actor: identity.email, action: 'node.rename', nodeId: node.id, target: label, result: 'ok', requestId });
    await hub(env).announceNode(node.id);
    return json(await store.nodeView(node.id));
  }
  match = m(/^\/api\/cloud\/nodes\/(node_[A-Za-z0-9_-]{16,64})\/revoke$/);
  if (request.method === 'POST' && match) {
    const nodeId = match[1]!;
    if (!(await store.node(nodeId))) throw new HttpError(404, 'NODE_NOT_FOUND', 'Unknown node.');
    const changed = await store.revokeNode(nodeId, identity.email);
    await hub(env).revoke(nodeId);
    await store.audit({ actor: identity.email, action: 'node.revoke', nodeId, result: changed ? 'ok' : 'already revoked', requestId });
    log('warn', 'node.revoked', { nodeId, requestId });
    return json(await store.nodeView(nodeId));
  }
  match = m(/^\/api\/cloud\/nodes\/(node_[A-Za-z0-9_-]{16,64})\/rotate$/);
  if (request.method === 'POST' && match) {
    const nodeId = match[1]!;
    const node = await store.node(nodeId);
    if (!node || node.revokedAt) throw new HttpError(404, 'NODE_NOT_FOUND', 'Unknown or revoked node.');
    const asked = await hub(env).requestRotation(nodeId, identity.email);
    if (!asked) throw new HttpError(503, 'NODE_OFFLINE', 'The node is offline; it can rotate its key once it reconnects.');
    await store.audit({ actor: identity.email, action: 'node.rotate.request', nodeId, result: 'sent', requestId });
    return json({ ok: true }, 202);
  }

  if (request.method === 'GET' && path === '/api/cloud/pairing-tokens') return json(await store.listPairingTokens());
  if (request.method === 'POST' && path === '/api/cloud/pairing-tokens') {
    const { success } = await env.PAIRING_LIMITER.limit({ key: `mint:${identity.email}` });
    if (!success) throw new HttpError(429, 'RATE_LIMITED', 'Too many pairing codes. Wait a minute.');
    const body = (await readJson(request, CLOUD_JSON_LIMIT)) as { label?: unknown } | undefined;
    const label = typeof body?.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : 'New node';
    const token = `${PAIRING_TOKEN_PREFIX}${randomToken(32)}`;
    const id = crypto.randomUUID();
    const expiresAt = isoIn(PAIRING_TTL_MS);
    await store.createPairingToken({ id, tokenHash: await secretHash(token), label, createdBy: identity.email, expiresAt });
    await store.audit({ actor: identity.email, action: 'pairing.create', target: id, result: 'ok', requestId });
    // The code is shown once; only its hash is stored.
    return json({ id, label, token, expiresAt }, 201);
  }
  match = m(/^\/api\/cloud\/pairing-tokens\/([0-9a-f-]{36})$/);
  if (request.method === 'DELETE' && match) {
    const ok = await store.revokePairingToken(match[1]!);
    await store.audit({ actor: identity.email, action: 'pairing.revoke', target: match[1]!, result: ok ? 'ok' : 'not active', requestId });
    return json({ ok });
  }

  if (request.method === 'GET' && path === '/api/cloud/commands') {
    const nodeId = url.searchParams.get('nodeId') ?? undefined;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
    return json(await store.listCommands({ ...(nodeId ? { nodeId } : {}), limit }));
  }
  match = m(/^\/api\/cloud\/commands\/([A-Za-z0-9_-]{8,80})$/);
  if (request.method === 'GET' && match) {
    const row = await store.command(match[1]!);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Unknown command.');
    return json({ ...commandView(row), result: row.result_body ? JSON.parse(row.result_body) : null });
  }
  if (request.method === 'GET' && path === '/api/cloud/audit') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
    return json(await store.listAudit(limit));
  }

  match = m(/^\/api\/cloud\/artifacts\/(node_[A-Za-z0-9_-]{16,64})\/([A-Za-z0-9._:-]{1,200})$/);
  if (request.method === 'GET' && match) {
    const manifest = await store.manifest(match[1]!, match[2]!);
    if (!manifest || manifest.status !== 'uploaded' || !manifest.r2_key) throw new HttpError(404, 'NOT_FOUND', 'This artifact is not stored in the cloud.');
    const object = await env.ARTIFACTS.get(manifest.r2_key);
    if (!object) throw new HttpError(404, 'NOT_FOUND', 'The stored object is missing.');
    return new Response(object.body, {
      headers: {
        'content-type': manifest.mime,
        'content-length': String(object.size),
        'content-disposition': `attachment; filename="${manifest.name.replace(/"/g, '')}"`,
        'x-acc-sha256': manifest.sha256 ?? '',
      },
    });
  }
  match = m(/^\/api\/cloud\/tasks\/(node_[A-Za-z0-9_-]{16,64})\/([A-Za-z0-9._:-]{1,200})\/artifacts$/);
  if (request.method === 'GET' && match) return json(await store.manifestsForTask(match[1]!, match[2]!));
  match = m(/^\/api\/cloud\/logs\/(node_[A-Za-z0-9_-]{16,64})\/([A-Za-z0-9._:-]{1,200})$/);
  if (request.method === 'GET' && match) {
    const chunks = await store.logChunks(match[1]!, match[2]!);
    const index = url.searchParams.get('chunk');
    if (index === null) return json(chunks.map(({ r2_key: _k, ...c }) => c));
    const chunk = chunks.find((c) => c.chunk_index === Number(index));
    const object = chunk ? await env.ARTIFACTS.get(chunk.r2_key) : null;
    if (!object) throw new HttpError(404, 'NOT_FOUND', 'Log chunk not found.');
    return new Response(object.body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'x-acc-sha256': chunk!.sha256 } });
  }
  throw new HttpError(404, 'NOT_FOUND', 'Not found');
}

/** The relay address nodes pair with: the first relay hostname (same scheme and port when it is this host, as in development). */
function relayOrigin(env: Env, url: URL): string {
  const host = env.RELAY_HOSTS.split(',').map((h) => h.trim()).find(Boolean) ?? url.hostname;
  return host === url.hostname ? url.origin : `https://${host}`;
}

async function health(env: Env): Promise<{ ok: boolean; checks: Array<{ name: string; ok: boolean; message: string }> }> {
  const checks: Array<{ name: string; ok: boolean; message: string }> = [];
  const probe = async (name: string, fn: () => Promise<string>) => {
    try {
      checks.push({ name, ok: true, message: await fn() });
    } catch (error) {
      checks.push({ name, ok: false, message: (error as Error).message.slice(0, 200) });
    }
  };
  await probe('database', async () => `${(await env.DB.prepare('SELECT COUNT(*) AS n FROM nodes').first<{ n: number }>())?.n ?? 0} nodes`);
  await probe('storage', async () => {
    await env.ARTIFACTS.head('health-probe');
    return 'reachable';
  });
  await probe('realtime', async () => `${(await hub(env).connectedNodes()).length} node(s) connected`);
  await probe('sign-in', async () => {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new Error('Access is not configured');
    return env.ACCESS_TEAM_DOMAIN;
  });
  return { ok: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------
// The typed operation proxy: reads over RPC, mutations as durable commands
// ---------------------------------------------------------------------------

interface Target {
  nodeId: string;
  /** For Automatic routing: the repository id on the chosen node. */
  repositoryId?: string;
}

async function resolveNode(request: Request, store: CloudStore, env: Env, operation: RemoteOperation, body: unknown): Promise<Target> {
  const requested = request.headers.get('x-acc-node');
  if (requested === 'auto') {
    if (operation.op !== 'task.create') throw new HttpError(400, 'NODE_REQUIRED', 'Automatic node choice applies to new tasks only.');
    const source = request.headers.get('x-acc-source-node') ?? '';
    const repositoryId = (body as { repositoryId?: unknown } | null)?.repositoryId;
    if (typeof repositoryId !== 'string') throw new HttpError(400, 'VALIDATION', 'Choose a repository.');
    const fingerprint = await store.repositoryFingerprint(source, repositoryId);
    if (!fingerprint) throw new HttpError(400, 'NODE_REQUIRED', 'The repository is unknown to the node it was chosen from.');
    const connected = new Set(await hub(env).connectedNodes());
    const rows = await env.DB.prepare('SELECT r.node_id, r.local_id FROM node_repositories r JOIN nodes n ON n.id = r.node_id WHERE r.fingerprint = ? AND n.revoked_at IS NULL').bind(fingerprint).all<{ node_id: string; local_id: string }>();
    const online = rows.results.filter((r) => connected.has(r.node_id));
    const chosen = online.find((r) => r.node_id === source) ?? online[0];
    if (!chosen) throw new HttpError(503, 'NODE_OFFLINE', 'No online node has this repository.');
    return { nodeId: chosen.node_id, repositoryId: chosen.local_id };
  }
  if (requested) {
    const node = await store.node(requested);
    if (!node) throw new HttpError(404, 'NODE_NOT_FOUND', 'Unknown node.');
    if (node.revokedAt) throw new HttpError(403, 'NODE_REVOKED', 'This node was revoked.');
    return { nodeId: node.id };
  }
  const active = (await store.listNodes()).filter((n) => n.status !== 'revoked');
  if (active.length === 1) return { nodeId: active[0]!.id };
  throw new HttpError(409, 'NODE_REQUIRED', active.length ? 'Choose a node.' : 'Pair a node first: Nodes → Pair a node.');
}

function replyToResponse(reply: RpcReply, source: 'live' | 'cache'): Response {
  const body = reply.encoding === 'base64' ? fromBase64url(reply.text.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')) : reply.text;
  return new Response(body, { status: reply.httpStatus, headers: { 'content-type': reply.contentType, 'x-acc-source': source } });
}

async function proxy(request: Request, env: Env, url: URL, identity: AccessIdentity, requestId: string): Promise<Response> {
  const matched = matchRemoteOperation(request.method, url.pathname);
  if (!matched) throw new HttpError(404, 'NOT_REMOTE', 'This action is only available on the machine itself.');
  const { operation, params } = matched;
  const store = new CloudStore(env.DB);
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    if (Object.keys(query).length >= REMOTE_LIMITS.queryKeys) break;
    query[k] = v.slice(0, REMOTE_LIMITS.queryValueChars);
  }
  const rawBody = request.method === 'GET' || request.method === 'DELETE' ? undefined : await readJson(request, REMOTE_LIMITS.commandBodyBytes);

  if (operation.kind === 'read') {
    const target = await resolveNode(request, store, env, operation, rawBody);
    const connected = await hub(env).isNodeConnected(target.nodeId);
    if (!connected) {
      if (operation.offline) {
        const cached = await offlineRead(env.DB, target.nodeId, operation.op, params, query);
        if (cached) return json(cached.body, cached.status, { 'x-acc-source': 'cache' });
      }
      throw new HttpError(503, 'NODE_OFFLINE', 'The node is offline. This view needs a live node.');
    }
    const reply = await hub(env).rpc(target.nodeId, { op: operation.op, params, query, ...(rawBody !== undefined ? { body: rawBody } : {}) });
    if ((reply.httpStatus === 503 || reply.httpStatus === 504) && operation.offline) {
      const cached = await offlineRead(env.DB, target.nodeId, operation.op, params, query);
      if (cached) return json(cached.body, cached.status, { 'x-acc-source': 'cache' });
    }
    return replyToResponse(reply, 'live');
  }

  // ----- a mutation: validate, bind, persist, then notify ------------------------
  const { success } = await env.COMMAND_LIMITER.limit({ key: `cmd:${identity.email}` });
  if (!success) throw new HttpError(429, 'RATE_LIMITED', 'Too many actions in a minute.');
  const validated = validateRemoteBody(operation, rawBody);
  if (!validated.ok) throw new HttpError(400, 'VALIDATION', validated.message);
  let body = validated.body;
  const target = await resolveNode(request, store, env, operation, body);
  if (target.repositoryId && body && typeof body === 'object') body = { ...(body as object), repositoryId: target.repositoryId };
  const node = (await store.nodeView(target.nodeId))!;
  if (node.updateRequired) throw new HttpError(426, 'NODE_UPDATE_REQUIRED', `This node speaks protocol ${node.protocolVersion}; the cloud needs ${REMOTE_MIN_PROTOCOL_VERSION}. Update it.`);
  if (operation.gate === 'terminals' && operation.op === 'terminal.open') {
    if (request.headers.get('x-acc-confirm') !== 'open-terminal') throw new HttpError(428, 'CONFIRMATION_REQUIRED', 'Confirm opening a remote terminal.');
    if (Date.now() / 1000 - identity.issuedAt > RECENT_SIGN_IN_S) throw new HttpError(401, 'REAUTH_REQUIRED', 'Sign in again (within the last hour) to open a remote terminal.');
  }

  const connected = await hub(env).isNodeConnected(target.nodeId);
  const queued = operation.op === 'task.create' && request.headers.get('x-acc-queue') === '1';
  if (!connected && !queued) throw new HttpError(503, 'NODE_OFFLINE', 'The node is offline, so nothing was sent. Try again when it is back.');

  const precondition = await bindPrecondition(request, store, target.nodeId, operation, params);
  const now = Date.now();
  const ttl = queued ? QUEUED_TASK_TTL_SECONDS : (operation.ttlSeconds ?? 120);
  const idempotencyKey = (request.headers.get('idempotency-key') ?? '').slice(0, 120) || randomToken(18);
  if (idempotencyKey.length < 8) throw new HttpError(400, 'VALIDATION', 'Idempotency-Key must be 8 to 120 characters.');
  const base = {
    id: `cmd_${randomToken(18)}`,
    nodeId: target.nodeId,
    op: operation.op,
    params,
    query,
    ...(body !== undefined ? { body } : {}),
    idempotencyKey,
    precondition,
    createdBy: identity.email,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl * 1000).toISOString(),
  };
  const command: RemoteCommand = { ...base, payloadHash: await commandPayloadHash(base) };

  let leaseFingerprint: string | null = null;
  if (operation.lease) {
    const repositoryId = operation.op === 'task.create' ? (body as { repositoryId?: string }).repositoryId : (await store.taskVersion(target.nodeId, params.id ?? ''))?.repositoryId;
    leaseFingerprint = repositoryId ? await store.repositoryFingerprint(target.nodeId, repositoryId) : null;
  }
  const inserted = await store.insertCommand({ ...command, taskId: operation.op.startsWith('task.') ? (params.id ?? null) : null, leaseFingerprint });
  if (!inserted.created) {
    // Same idempotency key again: answer with what the first request produced; never a second command.
    return commandResponse(inserted.command.status === 'succeeded' || inserted.command.status === 'failed' ? { status: inserted.command.status, command: commandView(inserted.command), ...(inserted.command.result_status ? { outcome: { httpStatus: inserted.command.result_status, body: inserted.command.result_body ? JSON.parse(inserted.command.result_body) : null } } : {}), ...(inserted.command.error_code ? { error: { code: inserted.command.error_code, message: inserted.command.error_message ?? '' } } : {}) } : { status: inserted.command.status, command: commandView(inserted.command) });
  }
  if (leaseFingerprint) {
    const lease = await store.acquireLease(leaseFingerprint, target.nodeId, command.id, identity.email);
    if (!lease.ok) {
      await store.transition(command.id, target.nodeId, 'rejected', { errorCode: 'LEASE_CONFLICT', errorMessage: 'Another node is working on this repository.' });
      throw new HttpError(409, 'LEASE_CONFLICT', `Another node is already working on this repository${lease.taskId ? ` (${lease.taskId})` : ''}. Wait for it to finish.`, { heldBy: lease.heldBy, taskId: lease.taskId });
    }
  }
  await store.audit({ actor: identity.email, action: `command.${operation.op}`, nodeId: target.nodeId, target: params.id ?? null, result: 'created', detail: { commandId: command.id, payloadHash: command.payloadHash, queued }, requestId });
  // Persisted first; only now is the node told. A missed notification is repaired by the node's reconnect sync.
  const wait = await hub(env).deliver(command, queued && !connected ? 0 : 20_000);
  return commandResponse(wait);
}

async function bindPrecondition(request: Request, store: CloudStore, nodeId: string, operation: RemoteOperation, params: Record<string, string>): Promise<CommandPrecondition | null> {
  if (operation.precondition === 'approval') {
    const approval = await store.entity<Parameters<typeof approvalBindingHash>[0] & { status: string }>(nodeId, 'approval', params.id ?? '');
    if (!approval) throw new HttpError(409, 'REMOTE_CONFLICT', 'This approval is not in the cloud yet. Refresh and try again.');
    if (approval.status !== 'pending') throw new HttpError(409, 'REMOTE_CONFLICT', 'This approval was already decided. Refresh.');
    return { kind: 'approval', approvalId: approval.id, hash: await approvalBindingHash(approval) };
  }
  if (operation.precondition === 'taskVersion') {
    const header = request.headers.get('x-acc-expected-version');
    if (header === null || !params.id) return null;
    const version = Number(header);
    if (!Number.isInteger(version) || version < 0) throw new HttpError(400, 'VALIDATION', 'x-acc-expected-version must be a whole number.');
    return { kind: 'taskVersion', taskId: params.id, version };
  }
  return null;
}

function commandResponse(w: CommandWait): Response {
  const headers = { 'x-acc-command-id': w.command.id, 'x-acc-command-status': w.status };
  if (w.outcome) return json(w.outcome.body ?? null, w.outcome.httpStatus, headers);
  if (w.error) return json({ error: { code: w.error.code, message: w.error.message, details: { command: w.command } } }, REFUSAL_STATUS[w.error.code] ?? 409, headers);
  if (w.status === 'expired') return json({ error: { code: 'REMOTE_COMMAND_EXPIRED', message: 'The node did not pick this up in time. Nothing ran.', details: { command: w.command } } }, 410, headers);
  if (w.status === 'rejected' || w.status === 'failed') return json({ error: { code: w.command.errorCode ?? 'REMOTE_UNAVAILABLE', message: w.command.errorMessage ?? 'The command did not run.', details: { command: w.command } } }, REFUSAL_STATUS[w.command.errorCode ?? ''] ?? 409, headers);
  // Still running on the node (or queued for it): the result arrives as a realtime update.
  return json({ pending: true, command: w.command }, 202, headers);
}


