import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/database.js';
import { OUTBOX_LIMIT, RemoteStore } from '../src/remote/store.js';

function freshStore(): RemoteStore {
  const db = openDatabase(path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-remote-store-')), 'acc.db'));
  migrate(db);
  return new RemoteStore(db);
}

describe('remote store', () => {
  it('records a command receipt once, before execution, and never twice', () => {
    const store = freshStore();
    expect(store.recordReceipt('cmd-1', 'task.pause', 'a'.repeat(64))).toBe(true);
    expect(store.recordReceipt('cmd-1', 'task.pause', 'a'.repeat(64))).toBe(false);
    expect(store.receipt('cmd-1')).toMatchObject({ status: 'running', reportedAt: null });
    store.finishReceipt('cmd-1', 'succeeded', { httpStatus: 200, result: { ok: true }, errorCode: null });
    expect(store.unreported().map((r) => r.commandId)).toEqual(['cmd-1']);
    store.markReported('cmd-1');
    expect(store.unreported()).toEqual([]);
    expect(store.receipt('cmd-1')).toMatchObject({ status: 'succeeded', httpStatus: 200, result: { ok: true } });
  });

  it('marks commands a restart interrupted instead of re-running them', () => {
    const store = freshStore();
    store.recordReceipt('cmd-2', 'task.cancel', 'b'.repeat(64));
    expect(store.interruptRunning()).toBe(1);
    expect(store.receipt('cmd-2')).toMatchObject({ status: 'interrupted', errorCode: 'REMOTE_INTERRUPTED' });
    expect(store.recordReceipt('cmd-2', 'task.cancel', 'b'.repeat(64))).toBe(false);
  });

  it('coalesces outbox events per entity and acknowledges by sequence', () => {
    const store = freshStore();
    const a = store.enqueue('task:T1', 'message', { v: 1 });
    store.enqueue('task:T2', 'message', { v: 1 });
    const c = store.enqueue('task:T1', 'message', { v: 2 });
    expect(c).toBeGreaterThan(a);
    const pending = store.pending(0, 10);
    expect(pending.map((p) => [p.entityKey, p.payload])).toEqual([
      ['task:T2', { v: 1 }],
      ['task:T1', { v: 2 }],
    ]);
    store.acknowledge(pending[0]!.seq);
    expect(store.pending(0, 10).map((p) => p.entityKey)).toEqual(['task:T1']);
    expect(store.syncState().ackedSeq).toBe(pending[0]!.seq);
  });

  it('bounds the outbox and schedules a full resync when it overflows', () => {
    const store = freshStore();
    store.setResyncRequired(false);
    for (let i = 0; i < OUTBOX_LIMIT + 5; i++) store.enqueue(`event:${i}`, 'message', { i });
    expect(store.outboxDepth()).toBe(OUTBOX_LIMIT);
    expect(store.pending(0, 1)[0]!.entityKey).toBe('event:5');
    expect(store.syncState().resyncRequired).toBe(true);
  });

  it('moves the sequence past the cloud cursor after a database restore', () => {
    const store = freshStore();
    store.enqueue('task:T1', 'message', {});
    store.ensureSequenceAtLeast(500);
    expect(store.enqueue('task:T2', 'message', {})).toBe(501);
    store.ensureSequenceAtLeast(10);
    expect(store.lastIssuedSeq()).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// Identity, pairing and the connection (against the in-process fake relay)
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { afterEach } from 'vitest';
import { backoffDelay, BACKOFF } from '../src/remote/connection.js';
import { FakeRelay } from './fake-relay.js';
import { addRepo, createTask, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function relay(): Promise<FakeRelay> {
  const r = await new FakeRelay().start();
  cleanups.push(() => r.stop());
  return r;
}

async function app(dataDir?: string): Promise<TestApp> {
  const t = await createTestApp(dataDir ? { dataDir } : {});
  cleanups.push(() => t.close());
  return t;
}

describe('node identity and pairing', () => {
  it('pairs with a one-time code, seals the private key, and reconnects after a restart', async () => {
    const r = await relay();
    const first = await createTestApp();
    const code = r.newPairingToken();
    const status = await first.services.remote.pair({ relayUrl: r.url, code, label: 'Test PC' });
    expect(status).toMatchObject({ paired: true, label: 'Test PC', enabled: true, remoteTerminals: false, remoteTools: false });
    await waitFor(() => first.services.remote.status().state, (s) => s === 'connected', 15_000, 'connected');
    const nodeId = status.nodeId!;
    // The code is single-use.
    await expect(first.services.remote.pair({ relayUrl: r.url, code, label: 'again' })).rejects.toThrow(/already paired/);

    // The private key is sealed: no PKCS#8 material in the database file, the config row or any status.
    const row = first.services.db.prepare('SELECT * FROM remote_config').get() as Record<string, string>;
    expect(row.private_key_ciphertext).toBeTruthy();
    expect(JSON.stringify(row)).not.toMatch(/BEGIN|MIG[A-Za-z0-9+/]{20}/);
    expect(JSON.stringify(first.services.remote.status())).not.toContain(row.private_key_ciphertext);
    await first.close();
    const file = readFileSync(`${first.dataDir}/acc.db`);
    expect(file.includes(Buffer.from('PRIVATE KEY'))).toBe(false);

    // Same data directory, new process: the sealed key opens and the node authenticates again.
    const connectionsBefore = r.connections;
    const second = await app(first.dataDir);
    await waitFor(() => second.services.remote.status().state, (s) => s === 'connected', 15_000, 'reconnected');
    expect(second.services.remote.status().nodeId).toBe(nodeId);
    expect(r.connections).toBe(connectionsBefore + 1);
  });

  it('refuses a used or unknown pairing code and a non-https relay', async () => {
    const r = await relay();
    const t = await app();
    await expect(t.services.remote.pair({ relayUrl: r.url, code: `accpair_${'x'.repeat(43)}`, label: 'PC' })).rejects.toThrow(/invalid, used or expired/);
    await expect(t.services.remote.pair({ relayUrl: 'http://relay.example.com', code: r.newPairingToken(), label: 'PC' })).rejects.toThrow(/https/);
    expect(t.services.remote.status()).toMatchObject({ paired: false, state: 'unpaired' });
  });

  it('rotates the key without changing the node id', async () => {
    const r = await relay();
    const t = await app();
    const { nodeId } = await t.services.remote.pair({ relayUrl: r.url, code: r.newPairingToken(), label: 'PC' });
    await waitFor(() => t.services.remote.status().state, (s) => s === 'connected', 15_000);
    const oldKey = JSON.stringify(r.nodes.get(nodeId!)!.publicKey);
    const rotated = await t.services.remote.rotate();
    expect(rotated).toMatchObject({ nodeId, keyVersion: 2 });
    expect(JSON.stringify(r.nodes.get(nodeId!)!.publicKey)).not.toBe(oldKey);
    await waitFor(() => t.services.remote.status().state, (s) => s === 'connected', 15_000, 'connected with the new key');
  });
});

describe('connection', () => {
  it('bounds the backoff with jitter', () => {
    expect(backoffDelay(0, () => 0.5)).toBe(BACKOFF.initialMs);
    expect(backoffDelay(3, () => 0.5)).toBe(8_000);
    expect(backoffDelay(50, () => 0.999)).toBeLessThanOrEqual(BACKOFF.maxMs * 1.2);
    expect(backoffDelay(50, () => 0)).toBeGreaterThanOrEqual(BACKOFF.maxMs * 0.8);
  });

  it('reconnects after the relay drops the socket', async () => {
    const r = await relay();
    const t = await app();
    await t.services.remote.pair({ relayUrl: r.url, code: r.newPairingToken(), label: 'PC' });
    await waitFor(() => r.connected, Boolean, 15_000, 'first connection');
    r.dropConnections();
    await waitFor(() => r.connections, (n) => n >= 2, 15_000, 'second connection');
    await waitFor(() => t.services.remote.status().state, (s) => s === 'connected', 15_000);
  });

  it('brings the cloud copy up to date when remote access is switched back on', async () => {
    const r = await relay();
    const t = await app();
    await t.services.remote.pair({ relayUrl: r.url, code: r.newPairingToken(), label: 'PC' });
    await waitFor(() => t.services.remote.status().state, (s) => s === 'connected', 15_000);
    await t.services.remote.updatePermissions({ enabled: false });
    // Work done while remote access is off is not queued.
    const repositoryId = await addRepo(t, await makeRepo());
    const taskId = await createTask(t, repositoryId, 'Work while remote access is off');
    await waitForStatus(t, taskId, ['COMPLETED'], 90_000);
    const seen = r.events.length;
    await t.services.remote.updatePermissions({ enabled: true });
    const mirrored = await waitFor(
      () => r.events.slice(seen).find((e) => e.payload?.type === 'task' && e.payload.task?.id === taskId),
      Boolean,
      15_000,
      'task resent after re-enabling',
    );
    expect(mirrored!.payload.task.status).toBe('COMPLETED');
  });

  it('keeps the local service fully usable when the cloud is unreachable', async () => {
    const r = await relay();
    const t = await app();
    await t.services.remote.pair({ relayUrl: r.url, code: r.newPairingToken(), label: 'PC' });
    await r.stop();
    await waitFor(() => t.services.remote.status().state, (s) => s === 'offline', 15_000, 'offline');
    const health = await t.api('GET', '/api/health');
    expect(health.status).toBe(200);
    expect((await t.api('GET', '/api/tasks')).status).toBe(200);
  });

  it('stops for good when the node is revoked', async () => {
    const r = await relay();
    const t = await app();
    const { nodeId } = await t.services.remote.pair({ relayUrl: r.url, code: r.newPairingToken(), label: 'PC' });
    await waitFor(() => r.connected, Boolean, 15_000);
    r.revoke(nodeId!);
    await waitFor(() => t.services.remote.status().state, (s) => s === 'revoked', 15_000, 'revoked');
    const count = r.connections;
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(r.connections).toBe(count);
  });
});

describe('local remote-access routes', () => {
  it('pairs and changes permissions through the local API, never through a remote request', async () => {
    const { matchRemoteOperation } = await import('@acc/shared');
    const r = await relay();
    const t = await app();
    expect((await t.api('GET', '/api/remote')).body).toMatchObject({ paired: false, state: 'unpaired' });
    const paired = await t.api('POST', '/api/remote/pair', { relayUrl: r.url, code: r.newPairingToken(), label: 'Desk PC' });
    expect(paired.status).toBe(200);
    expect(paired.body).toMatchObject({ paired: true, label: 'Desk PC' });
    expect(JSON.stringify(paired.body)).not.toMatch(/ciphertext|pkcs8|PRIVATE/i);
    const changed = await t.api('PATCH', '/api/remote', { remoteTerminals: true });
    expect(changed.body).toMatchObject({ remoteTerminals: true, remoteTools: false });
    // A request that came through a remote command is refused even though it carries the local token.
    const viaRemote = await t.api('PATCH', '/api/remote', { remoteTools: true }, { 'x-acc-remote-request': 'cmd-1' });
    expect(viaRemote).toMatchObject({ status: 403, body: { error: { code: 'REMOTE_FORBIDDEN' } } });
    // And none of these routes exists in the remote catalog.
    for (const [method, url] of [['GET', '/api/remote'], ['POST', '/api/remote/pair'], ['PATCH', '/api/remote'], ['POST', '/api/remote/unpair'], ['POST', '/api/remote/rotate']] as const) {
      expect(matchRemoteOperation(method, url)).toBeNull();
    }
    expect((await t.api('POST', '/api/remote/pair', { relayUrl: r.url, code: r.newPairingToken(), label: 'x' })).status).toBe(409);
    expect((await t.api('POST', '/api/remote/unpair')).body).toMatchObject({ paired: false });
  });
});
