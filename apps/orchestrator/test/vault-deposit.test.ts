import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VAULT_SYNC_REQUIRED } from '../src/tools/credentials.js';
import {
  deriveBridgeChannel,
  depositKeyId,
  generateBridgeKeyPair,
  generateDepositKeyPair,
  importDepositPrivateKey,
  openDeposit,
  type BridgeChannel,
} from '../src/tools/vault-bridge-protocol.js';
import { installFakeWrangler } from './fake-wrangler.js';
import { addRepo, createTestApp, makeRepo, TOKEN, type TestApp } from './helpers.js';

/**
 * The MyVault delivery box, Control Center side (docs/plans/secret-delivery-flow.md):
 * MyVault sets it up through a real bridge session; a generated secret is then
 * sealed into a stand-in for MyVault's Worker, released for deployment, and
 * marked synced — or held again — from the receipt.
 */

const VAULT = 'vault-deposit-test-1';

/** MyVault's Worker, as far as the delivery box goes. */
class FakeWorker {
  server!: http.Server;
  origin!: string;
  token = '';
  deposits = new Map<string, { sealed: any; posts: number; status: 'pending' | 'collected'; receipt: any }>();
  /** Answers for the next POSTs, in order; empty = accept. */
  script: number[] = [];
  receiptCalls = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.headers.authorization !== `Bearer ${this.token}`) return send(401, { error: 'unauthorized' });
        if (req.method === 'POST' && req.url === '/api/v1/deposits') {
          const scripted = this.script.shift();
          const body = JSON.parse(raw);
          const known = this.deposits.get(body.id);
          if (known) known.posts += 1;
          if (scripted && scripted !== 201) return send(scripted, { error: 'scripted' });
          if (known) return send(200, { id: body.id, status: known.status, receipt: known.receipt });
          this.deposits.set(body.id, { sealed: body.sealed, posts: 1, status: 'pending', receipt: null });
          return send(201, { id: body.id, status: 'pending', receipt: null });
        }
        if (req.method === 'POST' && req.url === '/api/v1/deposits/receipts') {
          this.receiptCalls += 1;
          const ids: string[] = JSON.parse(raw).ids;
          return send(200, { deposits: ids.filter((id) => this.deposits.has(id)).map((id) => ({ id, status: this.deposits.get(id)!.status, receipt: this.deposits.get(id)!.receipt })) });
        }
        send(404, { error: 'not_found' });
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  collect(id: string, receipt: Record<string, unknown>): void {
    const d = this.deposits.get(id)!;
    d.status = 'collected';
    d.receipt = receipt;
    d.sealed = null;
  }
}

async function session(t: TestApp, origin: string): Promise<{ channel: BridgeChannel; id: string; send: (type: string, body: unknown) => Promise<Array<{ type: string; body: any }>> }> {
  const keys = await generateBridgeKeyPair();
  const res = await t.api('POST', '/api/vault-bridge/sessions', { origin, vaultId: VAULT, publicKey: keys.publicKey });
  const channel = await deriveBridgeChannel({ role: 'myvault', sessionId: res.body.sessionId, privateKey: keys.privateKey, myvaultPublicKey: keys.publicKey, controlCenterPublicKey: res.body.publicKey });
  const send = async (type: string, body: unknown) => {
    const envelope = await channel.seal(type, body);
    const r = await t.app.inject({ method: 'POST', url: `/api/vault-bridge/sessions/${res.body.sessionId}/messages`, headers: { host: '127.0.0.1:4317', authorization: `Bearer ${TOKEN}` }, payload: { envelope } });
    const parsed = JSON.parse(r.body);
    const out = [];
    for (const e of parsed.replies ?? []) out.push(await channel.open(e));
    return out;
  };
  return { channel, id: res.body.sessionId, send };
}

describe('MyVault delivery box', () => {
  let t: TestApp;
  let repoId: string;
  const worker = new FakeWorker();
  let delivery: Awaited<ReturnType<typeof generateDepositKeyPair>>;
  let identityKey: string;

  const generate = async (name: string) => (await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'credential.generate', input: { name } })).body.result.output;
  const openLatest = async (id: string) =>
    openDeposit({ deposit: worker.deposits.get(id)!.sealed, vaultId: VAULT, recipient: { privateKey: await importDepositPrivateKey(delivery.privateJwk), publicKey: delivery.publicKey }, trustedIdentityKeys: [identityKey] });
  const depositFor = (credentialId: string) => t.services.toolStore.deposits({ credentialId }).at(-1)!;

  beforeAll(async () => {
    await worker.start();
    // A stand-in Wrangler in the repository: the deploy gate must answer whether or not
    // this machine has a global Wrangler (audit F-17 — CI runners do not).
    t = await createTestApp({ baseEnv: { ...process.env, FAKE_WRANGLER_STATE: path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-deposit-wrangler-')), 'state.json') } });
    const repoPath = await makeRepo({ files: { 'wrangler.toml': 'name = "fixture"\n' } });
    installFakeWrangler(repoPath);
    repoId = await addRepo(t, repoPath);
    await t.api('POST', '/api/vault-bridge/origins', { origin: worker.origin });
    identityKey = (await t.api('GET', '/api/vault-bridge/status')).body.identity.publicKey;
    delivery = await generateDepositKeyPair();
  }, 60_000);

  afterAll(async () => {
    await t.close();
    worker.server.close();
  });

  it('without a box, a generated secret waits for MyVault as before', async () => {
    const out = await generate('BEFORE_ANY_BOX');
    expect(out.vaultSync).toBe('pending_push');
    expect(t.services.credentials.deployGate('BEFORE_ANY_BOX', repoId, { taskId: null, target: 'x' })).toBe(VAULT_SYNC_REQUIRED);
  });

  it('MyVault sets the box up inside a bridge session, and only a valid offer is accepted', async () => {
    const s = await session(t, worker.origin);
    const started = await s.send('sync.start', {});
    expect(started.at(-1)).toMatchObject({ type: 'snapshot.request', body: { delivery: { accepted: false } } });
    const senderId = randomUUID();
    worker.token = `mvx_${senderId}_${'A'.repeat(43)}`;
    const keyId = await depositKeyId(delivery.publicKey);
    // A key id that does not match the key is refused, and nothing is stored.
    expect(await s.send('deposit.offer', { keyId: '0000000000000000', publicKey: delivery.publicKey, senderId, token: worker.token })).toEqual([{ type: 'deposit.accepted', body: expect.objectContaining({ ok: false }) }]);
    expect(await s.send('deposit.offer', { keyId, publicKey: delivery.publicKey, senderId, token: worker.token })).toEqual([{ type: 'deposit.accepted', body: { keyId, ok: true, detail: null } }]);
    const status = (await t.api('GET', '/api/vault-bridge/status')).body;
    expect(status.delivery).toEqual([expect.objectContaining({ origin: worker.origin, vaultId: VAULT, keyId, lastError: null })]);
    // The token is sealed at rest.
    expect(JSON.stringify(t.services.db.prepare('SELECT * FROM vault_deposit_targets').all())).not.toContain(worker.token);
    await s.send('bye', {});
    // The secret that was waiting goes into the box now.
    await expect.poll(() => t.services.credentials.get(t.services.toolStore.credential('BEFORE_ANY_BOX')!.id)!.vault!.state).toBe('deposited');
  });

  it('a new secret is sealed into the box at once and may be deployed immediately', async () => {
    const out = await generate('DELIVERED_SECRET');
    expect(out.vaultSync).toBe('deposited');
    const d = depositFor(out.id);
    expect(d.status).toBe('stored');
    const value = (await t.services.credentials.value('DELIVERED_SECRET', repoId))!;
    // Released: the gate is open, and only MyVault's delivery key can read what the Worker holds.
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.services.credentials.deployGate('DELIVERED_SECRET', repoId, { taskId: null, target: 'x' })).toBeNull();
    expect(await openLatest(d.id)).toMatchObject({ ccId: out.id, name: 'DELIVERED_SECRET', value, fingerprint: out.fingerprint });
    expect(JSON.stringify(worker.deposits.get(d.id)!.sealed)).not.toContain(value);
    // The receipt marks it synced, with the item MyVault made.
    worker.collect(d.id, { status: 'saved', fingerprint: out.fingerprint, itemId: `cc-${out.id}`, code: null, detail: null });
    await t.services.vaultBridge.deposits.poll();
    expect(t.services.credentials.get(out.id)!.vault).toMatchObject({ state: 'synced', itemId: `cc-${out.id}` });
    expect(depositFor(out.id).status).toBe('collected');
    const events = (await t.api('GET', `/api/credentials/${out.id}/events`)).body.map((e: { operation: string }) => e.operation);
    expect(events).toEqual(expect.arrayContaining(['generate', 'deposit', 'collected']));
  });

  it('a deposit MyVault could not open puts the secret back on hold for the bridge', async () => {
    const out = await generate('UNOPENED_SECRET');
    const d = depositFor(out.id);
    worker.collect(d.id, { status: 'error', fingerprint: null, itemId: null, code: 'cannot_open', detail: 'The delivery key was deleted' });
    await t.services.vaultBridge.deposits.poll();
    expect(t.services.credentials.get(out.id)!.vault).toMatchObject({ state: 'pending_push', lastError: expect.stringContaining('delivery key was deleted') });
    expect(t.services.credentials.deployGate('UNOPENED_SECRET', repoId, { taskId: null, target: 'x' })).toBe(VAULT_SYNC_REQUIRED);
    // And it is not sealed into the same box again.
    expect(t.services.vaultBridge.deposits.eligible(out.id)).toBeNull();
  });

  it('a lost answer is retried with the same deposit id, and a refused box says why', async () => {
    worker.script = [500];
    const out = await generate('RETRIED_SECRET');
    expect(out.vaultSync).toBe('pending_push');
    const reserved = depositFor(out.id);
    expect(reserved.status).toBe('sending');
    await t.services.vaultBridge.deposits.poll();
    expect(depositFor(out.id)).toMatchObject({ id: reserved.id, status: 'stored' });
    expect(t.services.credentials.get(out.id)!.vault!.state).toBe('deposited');

    const real = worker.token;
    worker.token = 'revoked';
    // A failed assertion must not leave the box refused for the tests after this one (audit F-17).
    let s: Awaited<ReturnType<typeof session>>;
    try {
      const blocked = await generate('REVOKED_BOX_SECRET');
      expect(blocked.vaultSync).toBe('pending_push');
      const gate = await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'cloudflare.secret_put', input: { credential: 'REVOKED_BOX_SECRET', secretName: 'X', environment: 'staging' }, confirmation: 'cloudflare.secret_put' });
      expect(gate.body.result.summary).toContain('delivery box');
      expect((await t.api('GET', '/api/vault-bridge/status')).body.delivery[0].lastError).toMatch(/no longer accepts deliveries/);
      // Refused: nothing more is sent, not even on the next check, until MyVault offers a new credential —
      // and the next session tells MyVault to do so.
      const posts = [...worker.deposits.values()].reduce((n, d) => n + d.posts, 0);
      await t.services.vaultBridge.deposits.poll();
      expect([...worker.deposits.values()].reduce((n, d) => n + d.posts, 0)).toBe(posts);
      s = await session(t, worker.origin);
      const started = await s.send('sync.start', {});
      expect(started.at(-1)!.body.delivery).toMatchObject({ accepted: true, healthy: false });
    } finally {
      worker.token = real;
    }
    const senderId = /^mvx_([0-9a-f-]{36})_/.exec(real)![1]!;
    await s.send('deposit.offer', { keyId: await depositKeyId(delivery.publicKey), publicKey: delivery.publicKey, senderId, token: real });
    await s.send('bye', {});
    await expect.poll(() => t.services.credentials.get(t.services.toolStore.credential('REVOKED_BOX_SECRET')!.id)!.vault!.state).toBe('deposited');
  });

  it('a busy box is not a refused one: MyVault is not asked for a new credential', async () => {
    worker.script = [429];
    const out = await generate('BUSY_BOX_SECRET');
    expect(out.vaultSync).toBe('pending_push');
    expect(t.services.vaultBridge.deposits.offerState(worker.origin, VAULT)).toMatchObject({ accepted: true, healthy: true });
    await t.services.vaultBridge.deposits.poll();
    expect(t.services.credentials.get(out.id)!.vault!.state).toBe('deposited');
  });

  it('checks every waiting deposit in one request, and a deposit the box lost is held again', async () => {
    const outs = [];
    for (const name of ['BATCH_A', 'BATCH_B', 'BATCH_C']) outs.push(await generate(name));
    const ids = outs.map((o) => depositFor(o.id).id);
    worker.collect(ids[0]!, { status: 'saved', fingerprint: outs[0].fingerprint, itemId: `cc-${outs[0].id}`, code: null, detail: null });
    worker.deposits.delete(ids[2]!);
    const before = worker.receiptCalls;
    await t.services.vaultBridge.deposits.poll();
    expect(worker.receiptCalls - before).toBe(1);
    expect(t.services.credentials.get(outs[0].id)!.vault!.state).toBe('synced');
    expect(t.services.credentials.get(outs[1].id)!.vault!.state).toBe('deposited');
    expect(t.services.credentials.get(outs[2].id)!.vault).toMatchObject({ state: 'pending_push', lastError: expect.stringContaining('no longer holds') });
  });

  it('replacements and values MyVault already holds never go through the box', async () => {
    const out = await generate('REPLACED_LATER');
    const d = depositFor(out.id);
    worker.collect(d.id, { status: 'saved', fingerprint: out.fingerprint, itemId: `cc-${out.id}`, code: null, detail: null });
    await t.services.vaultBridge.deposits.poll();
    await t.services.credentials.update(out.id, { value: ['replaced', randomUUID()].join('-') });
    expect(t.services.credentials.get(out.id)!.vault!.state).toBe('pending_push');
    expect(t.services.vaultBridge.deposits.eligible(out.id)).toBeNull();
  });

  it('removing trust in the address closes its box and holds back what was waiting in it', async () => {
    const waiting = await generate('WAITING_WHEN_UNTRUSTED');
    expect(waiting.vaultSync).toBe('deposited');
    await t.api('POST', '/api/vault-bridge/origins/remove', { origin: worker.origin });
    expect((await t.api('GET', '/api/vault-bridge/status')).body.delivery).toEqual([]);
    expect(t.services.credentials.get(waiting.id)!.vault).toMatchObject({ state: 'pending_push', lastError: expect.stringContaining('no longer trusted') });
    const after = await generate('AFTER_UNTRUST');
    expect(after.vaultSync).toBe('pending_push');
    expect(t.services.toolStore.deposits({ credentialId: after.id })).toEqual([]);
  });
});
