import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { sessionProofMessage, REMOTE_PROTOCOL_VERSION } from '@acc/shared';
import { createTestApp, waitFor, type TestApp } from '../../orchestrator/test/helpers.js';
import { httpJson, startCloud, type Cloud } from './harness.js';

/**
 * Node enrollment against the real Workers runtime: pairing codes, challenge
 * sessions, replay protection, revocation, rotation and rate limits
 * (docs/systems/cloud-control.md §Nodes).
 */

let cloud: Cloud;
const apps: TestApp[] = [];
beforeAll(async () => {
  cloud = await startCloud();
});
afterAll(async () => {
  for (const a of apps) await a.close().catch(() => undefined);
  await cloud?.stop();
});

async function pairingCode(label = 'Test node'): Promise<string> {
  const r = await cloud.api('POST', '/api/cloud/pairing-tokens', { label });
  expect(r.status).toBe(201);
  return r.body.token as string;
}

async function manualKeys() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! },
    sign: async (message: string) => Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(message))).toString('base64url'),
  };
}

function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
  return httpJson(cloud.url, 'POST', pathname, body, headers);
}

const info = { label: 'Manual', os: 'test', appVersion: 'test', protocolVersion: REMOTE_PROTOCOL_VERSION };

describe('pairing codes', () => {
  it('pairs once, stores only a hash, and refuses the code again', async () => {
    const token = await pairingCode();
    const keys = await manualKeys();
    const first = await post('/node/v1/pair', { ...info, token, publicKey: keys.publicKey });
    expect(first.status).toBe(201);
    expect(first.body.nodeId).toMatch(/^node_/);
    const again = await post('/node/v1/pair', { ...info, token, publicKey: keys.publicKey });
    expect(again.status).toBe(401);
    const rows = await cloud.d1('SELECT token_hash, used_at FROM pairing_tokens');
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows.some((r) => r.used_at)).toBe(true);
    const audit = await cloud.api('GET', '/api/cloud/audit');
    expect(audit.body.map((a: { action: string; result: string }) => `${a.action}:${a.result}`)).toEqual(expect.arrayContaining(['node.pair:ok', 'node.pair:refused', 'pairing.create:ok']));
    expect(JSON.stringify(audit.body)).not.toContain(token);
  });

  it('refuses an expired or revoked code', async () => {
    const expired = await pairingCode('expired');
    await cloud.d1(`UPDATE pairing_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE label = 'expired'`);
    const keys = await manualKeys();
    expect((await post('/node/v1/pair', { ...info, token: expired, publicKey: keys.publicKey })).status).toBe(401);
    const revoked = await cloud.api('POST', '/api/cloud/pairing-tokens', { label: 'revoked' });
    expect((await cloud.api('DELETE', `/api/cloud/pairing-tokens/${revoked.body.id}`)).body).toEqual({ ok: true });
    expect((await post('/node/v1/pair', { ...info, token: revoked.body.token, publicKey: keys.publicKey })).status).toBe(401);
  });
});

describe('challenge sessions', () => {
  it('refuses a wrong signature and a replayed nonce, and binds sessions to the key version', async () => {
    const keys = await manualKeys();
    const { body } = await post('/node/v1/pair', { ...info, token: await pairingCode(), publicKey: keys.publicKey });
    const nodeId = body.nodeId as string;
    const wrong = await manualKeys();
    const c1 = await post('/node/v1/challenge', { nodeId });
    expect(c1.status).toBe(200);
    const bad = await post('/node/v1/session', { nodeId, nonce: c1.body.nonce, signature: await wrong.sign(sessionProofMessage('session', nodeId, c1.body.nonce)), protocolVersion: REMOTE_PROTOCOL_VERSION });
    expect(bad.status).toBe(401);
    // The nonce was spent by the failed attempt: the right signature cannot use it now.
    const replay = await post('/node/v1/session', { nodeId, nonce: c1.body.nonce, signature: await keys.sign(sessionProofMessage('session', nodeId, c1.body.nonce)), protocolVersion: REMOTE_PROTOCOL_VERSION });
    expect(replay.status).toBe(401);
    const c2 = await post('/node/v1/challenge', { nodeId });
    const ok = await post('/node/v1/session', { nodeId, nonce: c2.body.nonce, signature: await keys.sign(sessionProofMessage('session', nodeId, c2.body.nonce)), protocolVersion: REMOTE_PROTOCOL_VERSION });
    expect(ok.status).toBe(200);
    const session = ok.body.session as string;
    const reuse = await post('/node/v1/session', { nodeId, nonce: c2.body.nonce, signature: await keys.sign(sessionProofMessage('session', nodeId, c2.body.nonce)), protocolVersion: REMOTE_PROTOCOL_VERSION });
    expect(reuse.status).toBe(401);
    // A signature for another purpose (rotation) does not open a session.
    const c3 = await post('/node/v1/challenge', { nodeId });
    expect((await post('/node/v1/session', { nodeId, nonce: c3.body.nonce, signature: await keys.sign(sessionProofMessage('rotate', nodeId, c3.body.nonce)), protocolVersion: REMOTE_PROTOCOL_VERSION })).status).toBe(401);
    // Rotation: the new key signs a fresh challenge; old sessions die with the old key version.
    const next = await manualKeys();
    const c4 = await post('/node/v1/challenge', { nodeId });
    const rotated = await post('/node/v1/rotate', { nonce: c4.body.nonce, publicKey: next.publicKey, signature: await next.sign(sessionProofMessage('rotate', nodeId, c4.body.nonce)) }, { authorization: `Bearer ${session}` });
    expect(rotated.status).toBe(200);
    const c5 = await post('/node/v1/challenge', { nodeId });
    expect((await post('/node/v1/rotate', { nonce: c5.body.nonce, publicKey: next.publicKey, signature: await next.sign(sessionProofMessage('rotate', nodeId, c5.body.nonce)) }, { authorization: `Bearer ${session}` })).status).toBe(401);
    const c6 = await post('/node/v1/challenge', { nodeId });
    expect((await post('/node/v1/session', { nodeId, nonce: c6.body.nonce, signature: await keys.sign(sessionProofMessage('session', nodeId, c6.body.nonce)), protocolVersion: REMOTE_PROTOCOL_VERSION })).status).toBe(401);
    expect((await cloud.d1(`SELECT key_version FROM nodes WHERE id = '${nodeId}'`))[0].key_version).toBe(2);
  });

  it('refuses a forged or missing session on the WebSocket', async () => {
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`${cloud.url.replace('http', 'ws')}/node/v1/connect`, { headers });
        ws.on('open', () => {
          ws.close();
          resolve(101);
        });
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('error', () => resolve(0));
      });
    expect(await status({})).toBe(401);
    expect(await status({ authorization: 'Bearer accs1.e30.AAAA' })).toBe(401);
  });
});

describe('a real node', () => {
  it('pairs, connects, reports capabilities, rotates on request and stops when revoked', async () => {
    const node = await createTestApp();
    apps.push(node);
    const status = await node.services.remote.pair({ relayUrl: cloud.url, code: await pairingCode('Workstation'), label: 'Workstation' });
    const nodeId = status.nodeId!;
    await waitFor(() => node.services.remote.status().state, (s) => s === 'connected', 30_000, 'connected');
    const view = await waitFor(async () => (await cloud.api('GET', '/api/cloud/nodes')).body.find((n: { id: string }) => n.id === nodeId), (n) => n?.capabilities !== null && n?.status === 'online', 20_000, 'capabilities');
    expect(view).toMatchObject({ label: 'Workstation', status: 'online', protocolVersion: REMOTE_PROTOCOL_VERSION, keyVersion: 1 });
    expect(view.capabilities.agents.map((a: { id: string }) => a.id).sort()).toEqual(['claude', 'codex']);
    expect(view.capabilities.features).toMatchObject({ remoteTerminals: false, remoteTools: false, simulatedAgents: true });

    // Rotation requested from the cloud: new key, same node, reconnected.
    expect((await cloud.api('POST', `/api/cloud/nodes/${nodeId}/rotate`)).status).toBe(202);
    await waitFor(async () => (await cloud.d1(`SELECT key_version FROM nodes WHERE id = '${nodeId}'`))[0].key_version, (v) => v === 2, 20_000, 'key rotated');
    await waitFor(() => node.services.remote.status(), (s) => s.keyVersion === 2 && s.state === 'connected', 30_000, 'reconnected with new key');

    // Revocation closes the live socket at once and blocks every new session.
    const revoked = await cloud.api('POST', `/api/cloud/nodes/${nodeId}/revoke`);
    expect(revoked.body).toMatchObject({ status: 'revoked' });
    await waitFor(() => node.services.remote.status().state, (s) => s === 'revoked', 20_000, 'node sees revocation');
    expect((await post('/node/v1/challenge', { nodeId })).status).toBe(403);
    const refused = await cloud.api('GET', '/api/settings', undefined, { 'x-acc-node': nodeId });
    expect(refused.status).toBe(403);
  });

  it('rate-limits pairing attempts', async () => {
    const keys = await manualKeys();
    const statuses: number[] = [];
    // The limit is 20 a minute in windows aligned to the wall clock, so attempts that straddle a
    // minute boundary can split 15 + 15 and never pass it. 41 attempts (2 × 20 + 1, well under a
    // minute) always put more than 20 into one window; stop at the first refusal.
    for (let i = 0; i < 41 && !statuses.includes(429); i++) statuses.push((await post('/node/v1/pair', { ...info, token: `accpair_${'x'.repeat(43)}`, publicKey: keys.publicKey })).status);
    expect(statuses).toContain(429);
  });
});
