import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newCredentialKey, redact, secretFingerprint } from '@acc/security';
import { matchRemoteOperation } from '@acc/shared';
import { Bus } from '../src/bus.js';
import { migrate, openDatabase } from '../src/db/database.js';
import { CredentialBroker, VAULT_SYNC_REQUIRED, type VaultAck, type VaultItemInput } from '../src/tools/credentials.js';
import { ToolStore } from '../src/tools/store.js';
import { VaultBridgeService } from '../src/tools/vault-bridge.js';
import { deriveBridgeChannel, generateBridgeKeyPair, type BridgeChannel, type SealedEnvelope } from '../src/tools/vault-bridge-protocol.js';
import { operatorScope } from '../src/http/tool-routes.js';
import { ToolService } from '../src/tools/service.js';
import { addRepo, createTestApp, makeRepo, TOKEN, type TestApp } from './helpers.js';

/**
 * The MyVault credential bridge (docs/plans/myvault-credential-bridge.md):
 * the broker's link rules, the bridge service and its routes, the generated
 * secret tool and the vault-before-deploy gate.
 */

const ORIGIN = 'https://vault.example';
const VAULT = 'vault-1';
/** Values are assembled at runtime so no credential-shaped literal is committed. */
const secret = (label: string) => [label, randomUUID(), randomUUID()].join('-');

function brokerHarness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-bridge-'));
  const db = openDatabase(path.join(dir, 'acc.db'));
  migrate(db);
  const store = new ToolStore(db);
  const key = newCredentialKey();
  const broker = new CredentialBroker(store, new Bus(), { load: async () => key });
  return { db, store, broker };
}

const item = (over: Partial<VaultItemInput> = {}): VaultItemInput => ({ itemId: randomUUID(), title: 'Stripe key', kind: 'other', envVar: 'STRIPE_KEY', value: secret('stripe'), updatedAt: '2026-09-23T10:00:00.000Z', ccId: null, authority: 'myvault', ...over });
const ack = (over: Partial<VaultAck>): VaultAck => ({ itemId: randomUUID(), status: 'saved', fingerprint: null, vaultFingerprint: null, updatedAt: '2026-09-23T10:00:00.000Z', cloudPending: false, detail: null, ...over });

describe('broker: MyVault imports', () => {
  it('imports a shared item encrypted, scoped to no repository, and idempotent by item id', async () => {
    const { broker, db } = brokerHarness();
    const shared = item({ title: 'Stripe live/key!' });
    const first = await broker.applyVaultItem(ORIGIN, VAULT, shared);
    expect(first.outcome).toBe('imported');
    const view = broker.get(first.credentialId!)!;
    expect(view).toMatchObject({ name: 'Stripe-live-key', source: 'myvault', repositoryIds: [], envVar: 'STRIPE_KEY', vault: { authority: 'myvault', state: 'synced', origin: ORIGIN, itemId: shared.itemId } });
    // No repository may use it until one is assigned.
    expect(await broker.value(view.name, 'any-repo')).toBeNull();
    expect(await broker.value(view.name, null)).toBeNull();
    expect(redact(`echo ${shared.value}`)).not.toContain(shared.value);
    // The same item again is a no-op; a new title does not create a second credential.
    expect((await broker.applyVaultItem(ORIGIN, VAULT, { ...shared, title: 'Renamed' })).outcome).toBe('unchanged');
    expect(broker.list()).toHaveLength(1);
    const raw = JSON.stringify(db.prepare('SELECT * FROM credential_references').all()) + JSON.stringify(db.prepare('SELECT * FROM credential_vault_links').all()) + JSON.stringify(db.prepare('SELECT * FROM credential_events').all());
    expect(raw).not.toContain(shared.value);
    await broker.update(view.id, { repositoryIds: ['repo-a'] });
    expect(await broker.value(view.name, 'repo-a')).toBe(shared.value);
  });

  it('follows a new MyVault value and refuses a local replacement while MyVault owns it', async () => {
    const { broker } = brokerHarness();
    const shared = item();
    const { credentialId } = await broker.applyVaultItem(ORIGIN, VAULT, shared);
    await expect(broker.update(credentialId!, { value: secret('local') })).rejects.toMatchObject({ code: 'MANAGED' });
    const rotated = secret('rotated');
    expect((await broker.applyVaultItem(ORIGIN, VAULT, { ...shared, value: rotated, kind: 'cloudflare' })).outcome).toBe('updated');
    await broker.update(credentialId!, { repositoryIds: ['r'] });
    expect(await broker.value(credentialId!, 'r')).toBe(rotated);
    expect(broker.get(credentialId!)).toMatchObject({ kind: 'cloudflare', fingerprint: secretFingerprint(rotated) });
    // Detaching stops following MyVault and makes the value editable here.
    broker.resolve(credentialId!, 'detach');
    await broker.update(credentialId!, { value: secret('local') });
    expect((await broker.applyVaultItem(ORIGIN, VAULT, { ...shared, value: secret('ignored') })).outcome).toBe('unchanged');
    expect(broker.get(credentialId!)!.vault!.state).toBe('detached');
  });

  it('drops a reserved variable from an imported item', async () => {
    const { broker } = brokerHarness();
    const { credentialId } = await broker.applyVaultItem(ORIGIN, VAULT, item({ envVar: 'PATH' }));
    expect(broker.get(credentialId!)!.envVar).toBeNull();
  });

  it('marks unseen links missing only when told the snapshot was complete, and never deletes', async () => {
    const { broker } = brokerHarness();
    const a = await broker.applyVaultItem(ORIGIN, VAULT, item());
    const b = await broker.applyVaultItem(ORIGIN, VAULT, item());
    expect(broker.markUnseen(ORIGIN, VAULT, new Set([a.credentialId!]))).toBe(1);
    expect(broker.get(b.credentialId!)!.vault).toMatchObject({ state: 'missing' });
    expect(broker.get(a.credentialId!)!.vault).toMatchObject({ state: 'synced' });
    // Another vault's snapshot never touches these links.
    expect(broker.markUnseen(ORIGIN, 'other-vault', new Set())).toBe(0);
    expect(broker.list()).toHaveLength(2);
  });
});

describe('broker: generated secrets', () => {
  it('generates with the CSPRNG, seals before returning, and is idempotent by name', async () => {
    const { broker, db } = brokerHarness();
    const input = { name: 'SESSION_SECRET', kind: 'other' as const, envVar: null, description: '', bytes: 32, encoding: 'base64url' as const, repositoryIds: ['repo-a'], taskId: null };
    const first = await broker.generate(input);
    expect(first.created).toBe(true);
    expect(first.credential).toMatchObject({ source: 'generated', repositoryIds: ['repo-a'], vault: { authority: 'control-center', state: 'pending_push', firstSyncedAt: null } });
    const value = (await broker.value('SESSION_SECRET', 'repo-a', { includeUnsynced: true }))!;
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redact(value)).toBe('[REDACTED]');
    const again = await broker.generate(input);
    expect(again.created).toBe(false);
    expect(await broker.value('SESSION_SECRET', 'repo-a', { includeUnsynced: true })).toBe(value);
    expect(JSON.stringify(db.prepare('SELECT * FROM credential_references').all())).not.toContain(value);
    const hex = await broker.generate({ ...input, name: 'WEBHOOK', encoding: 'hex', bytes: 16 });
    expect(await broker.value(hex.credential.name, 'repo-a', { includeUnsynced: true })).toMatch(/^[0-9a-f]{32}$/);
    const values = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      await broker.generate({ ...input, name: `S${i}` });
      values.add((await broker.value(`S${i}`, 'repo-a', { includeUnsynced: true }))!);
    }
    expect(values.size).toBe(20);
    await broker.create({ name: 'manual', kind: 'other', value: secret('m') });
    await expect(broker.generate({ ...input, name: 'manual' })).rejects.toMatchObject({ code: 'DUPLICATE' });
    // Another repository asking for the same name gets the same answer, not that repository's secret.
    await expect(broker.generate({ ...input, repositoryIds: ['repo-b'] })).rejects.toMatchObject({ code: 'DUPLICATE', message: 'This name is already in use. Choose another name.' });
    // A generated secret can never take a system or provider variable, nor be a provider token.
    await expect(broker.generate({ ...input, name: 'P', envVar: 'PATH' })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(broker.generate({ ...input, name: 'C', envVar: 'cloudflare_api_token' })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(broker.generate({ ...input, name: 'K', kind: 'cloudflare' as never })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(broker.generate({ ...input, name: 'tiny', bytes: 8 })).rejects.toMatchObject({ code: 'INVALID' });
  });

  it('blocks deployment until MyVault acknowledges exactly the current value', async () => {
    const { broker } = brokerHarness();
    const { credential } = await broker.generate({ name: 'API_SECRET', kind: 'other', envVar: null, description: '', bytes: 32, encoding: 'base64url', repositoryIds: null, taskId: null });
    const ctx = { taskId: null, target: 'worker API_SECRET' };
    expect(broker.deployGate('API_SECRET', 'r', ctx)).toBe(VAULT_SYNC_REQUIRED);
    const [push] = await broker.pendingPushes(ORIGIN, VAULT, 10);
    expect(push!.fingerprint).toBe(credential.fingerprint);
    // A wrong fingerprint in the answer does not count as an acknowledgement.
    broker.recordPushAck(credential.id, ORIGIN, VAULT, push!.fingerprint, ack({ fingerprint: '00000000' }));
    expect(broker.deployGate('API_SECRET', 'r', ctx)).toBe(VAULT_SYNC_REQUIRED);
    broker.recordPushAck(credential.id, ORIGIN, VAULT, push!.fingerprint, ack({ fingerprint: push!.fingerprint, cloudPending: true }));
    expect(broker.get(credential.id)!.vault).toMatchObject({ state: 'synced', origin: ORIGIN });
    expect(broker.deployGate('API_SECRET', 'r', ctx)).toBeNull();
    // A new local value is owed to MyVault again, and blocks again until acknowledged.
    await broker.update(credential.id, { value: secret('replaced') });
    expect(broker.get(credential.id)!.vault!.state).toBe('pending_push');
    expect(broker.deployGate('API_SECRET', 'r', ctx)).toBe(VAULT_SYNC_REQUIRED);
    expect(broker.events(credential.id).map((e) => e.operation)).toEqual(expect.arrayContaining(['generate', 'ack', 'replace', 'deploy_blocked']));
    expect(JSON.stringify(broker.events())).not.toContain(push!.value);
  });

  it('turns an edited MyVault copy into a conflict and resolves it only by an explicit choice', async () => {
    const { broker } = brokerHarness();
    const { credential } = await broker.generate({ name: 'SIGNING', kind: 'other', envVar: null, description: '', bytes: 32, encoding: 'base64url', repositoryIds: ['r'], taskId: null });
    const [push] = await broker.pendingPushes(ORIGIN, VAULT, 10);
    const itemId = randomUUID();
    broker.recordPushAck(credential.id, ORIGIN, VAULT, push!.fingerprint, ack({ itemId, fingerprint: push!.fingerprint }));
    const edited = secret('edited-in-vault');
    const snap = { itemId, title: 'SIGNING', kind: 'other' as const, envVar: null, value: edited, updatedAt: null, ccId: credential.id, authority: 'control-center' as const };
    expect((await broker.applyVaultItem(ORIGIN, VAULT, snap)).outcome).toBe('conflict');
    expect(await broker.value('SIGNING', 'r')).toBe(push!.value);
    // Keep the Control Center value: the next push may replace exactly the edited copy.
    broker.resolve(credential.id, 'keep-control-center');
    const [again] = await broker.pendingPushes(ORIGIN, VAULT, 10);
    expect(again!.replaceFingerprint).toBe(secretFingerprint(edited));
    // Or take the MyVault value instead, on the next snapshot.
    // A choice that does not fit the state is refused.
    await expect(Promise.resolve().then(() => broker.resolve(credential.id, 'use-myvault'))).rejects.toMatchObject({ code: 'INVALID' });
    broker.recordPushAck(credential.id, ORIGIN, VAULT, again!.fingerprint, ack({ itemId, status: 'conflict', vaultFingerprint: secretFingerprint(edited) }));
    broker.resolve(credential.id, 'use-myvault');
    expect((await broker.applyVaultItem(ORIGIN, VAULT, snap)).outcome).toBe('updated');
    expect(await broker.value('SIGNING', 'r')).toBe(edited);
    expect(broker.get(credential.id)!.vault!.state).toBe('synced');
  });

  it('leaves a detached generated secret alone, and push-again rebinds it', async () => {
    const { broker } = brokerHarness();
    const { credential } = await broker.generate({ name: 'DETACHED', kind: 'other', envVar: null, description: '', bytes: 32, encoding: 'base64url', repositoryIds: ['r'], taskId: null });
    const [push] = await broker.pendingPushes(ORIGIN, VAULT, 10);
    broker.recordPushAck(credential.id, ORIGIN, VAULT, push!.fingerprint, ack({ fingerprint: push!.fingerprint }));
    broker.resolve(credential.id, 'detach');
    const snap = { itemId: 'i', title: 'DETACHED', kind: 'other' as const, envVar: null, value: secret('other'), updatedAt: null, ccId: credential.id, authority: 'control-center' as const };
    expect((await broker.applyVaultItem(ORIGIN, VAULT, snap)).outcome).toBe('unchanged');
    await broker.update(credential.id, { value: secret('local') });
    expect(broker.get(credential.id)!.vault!.state).toBe('detached');
    broker.resolve(credential.id, 'push-again');
    expect(broker.get(credential.id)!.vault).toMatchObject({ state: 'pending_push', origin: null });
    // Unbound: another trusted vault may now receive it.
    expect((await broker.pendingPushes('https://moved.example', 'vault-2', 10)).map((p) => p.credentialId)).toContain(credential.id);
  });

  it('rejects a snapshot item that claims a credential it cannot own', async () => {
    const { broker } = brokerHarness();
    const manual = await broker.create({ name: 'manual', kind: 'other', value: secret('m') });
    expect((await broker.applyVaultItem(ORIGIN, VAULT, item({ ccId: manual.id, authority: 'control-center' }))).outcome).toBe('rejected');
    expect((await broker.applyVaultItem(ORIGIN, VAULT, item({ ccId: 'no-such-id', authority: 'control-center' }))).outcome).toBe('rejected');
    const { credential } = await broker.generate({ name: 'BOUND', kind: 'other', envVar: null, description: '', bytes: 32, encoding: 'base64url', repositoryIds: [], taskId: null });
    const [push] = await broker.pendingPushes(ORIGIN, VAULT, 10);
    broker.recordPushAck(credential.id, ORIGIN, VAULT, push!.fingerprint, ack({ fingerprint: push!.fingerprint }));
    // Bound to this vault now: another origin can neither claim it nor receive it.
    expect((await broker.applyVaultItem('https://other.example', VAULT, item({ ccId: credential.id, authority: 'control-center', value: push!.value }))).outcome).toBe('rejected');
    await broker.update(credential.id, { value: secret('next') });
    expect(await broker.pendingPushes('https://other.example', VAULT, 10)).toEqual([]);
  });
});

/** MyVault's side of a session, driving the real routes the dashboard's bridge page relays to. */
class FakeVault {
  channel!: BridgeChannel;
  sessionId!: string;
  code!: string;
  constructor(
    public t: TestApp,
    readonly origin = ORIGIN,
    readonly vaultId = VAULT,
  ) {}

  async connect(): Promise<{ status: number; body: any }> {
    const keys = await generateBridgeKeyPair();
    const res = await this.t.api('POST', '/api/vault-bridge/sessions', { origin: this.origin, vaultId: this.vaultId, publicKey: keys.publicKey });
    if (res.status !== 201) return res;
    this.sessionId = res.body.sessionId;
    this.code = res.body.code;
    this.channel = await deriveBridgeChannel({ role: 'myvault', sessionId: this.sessionId, privateKey: keys.privateKey, myvaultPublicKey: keys.publicKey, controlCenterPublicKey: res.body.publicKey });
    return res;
  }

  /** Sends one message; returns the opened replies, the raw HTTP body text and the status. */
  async send(type: string, body: unknown): Promise<Relayed> {
    return this.relay(await this.channel.seal(type, body));
  }

  async relay(envelope: unknown): Promise<Relayed> {
    const res = await this.t.app.inject({ method: 'POST', url: `/api/vault-bridge/sessions/${this.sessionId}/messages`, headers: { host: '127.0.0.1:4317', authorization: `Bearer ${TOKEN}` }, payload: { envelope } as object });
    const parsed = JSON.parse(res.body);
    const replies: Relayed['replies'] = [];
    if (res.statusCode === 200) for (const e of parsed.replies) replies.push(await this.channel.open(e));
    return { status: res.statusCode, raw: res.body, replies, envelope: envelope as SealedEnvelope, error: parsed.error?.code };
  }
}

interface Relayed {
  status: number;
  raw: string;
  replies: Array<{ type: string; body: any }>;
  envelope: SealedEnvelope;
  error?: string;
}

const missingCount = async (t: TestApp) => (await t.api('GET', '/api/credentials')).body.filter((c: { vault: { state: string } | null }) => c.vault?.state === 'missing').length;

describe('bridge service over HTTP', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  it('only a trusted, well-formed origin can open a session', async () => {
    const vault = new FakeVault(t);
    expect((await vault.connect()).body.error.code).toBe('UNTRUSTED_ORIGIN');
    for (const bad of ['http://evil.example', 'javascript:alert(1)', 'https://user:pw@vault.example', 'not a url']) {
      expect((await t.api('POST', '/api/vault-bridge/origins', { origin: bad })).status).toBe(400);
    }
    const trusted = await t.api('POST', '/api/vault-bridge/origins', { origin: `${ORIGIN}/some/path` });
    expect(trusted.body.origins.map((o: { origin: string }) => o.origin)).toEqual([ORIGIN]);
    expect((await vault.connect()).status).toBe(201);
    expect(vault.code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    const status = await t.api('GET', '/api/vault-bridge/status');
    expect(status.body.sessions).toEqual([expect.objectContaining({ origin: ORIGIN, code: vault.code })]);
    expect((await t.api('POST', '/api/vault-bridge/sessions', { origin: ORIGIN, vaultId: VAULT, publicKey: 'AAAA' })).body.error.code).toBe('PROTOCOL');
    // None of these routes is reachable from the cloud control plane.
    for (const [method, url] of [
      ['POST', '/api/vault-bridge/sessions'],
      ['POST', '/api/vault-bridge/sessions/x/messages'],
      ['GET', '/api/vault-bridge/status'],
      ['POST', '/api/vault-bridge/origins'],
      ['POST', '/api/credentials/x/vault-resolve'],
    ] as const) {
      expect(matchRemoteOperation(method, url)).toBeNull();
    }
  });

  it('pushes a generated secret sealed, imports shared items, and never sends a value in clear', async () => {
    await t.api('POST', '/api/vault-bridge/origins', { origin: ORIGIN });
    const { credential } = await t.services.credentials.generate({ name: 'BRIDGE_SECRET', kind: 'other', envVar: null, description: '', bytes: 32, encoding: 'base64url', repositoryIds: [], taskId: null });
    const value = (await t.services.credentials.pendingPushes(ORIGIN, VAULT, 100)).find((p) => p.credentialId === credential.id)!.value;
    const vault = new FakeVault(t);
    await vault.connect();
    const start = await vault.send('sync.start', {});
    expect(start.status).toBe(200);
    expect(start.raw).not.toContain(value);
    const push = start.replies.find((r) => r.type === 'credential.push' && r.body.ccId === credential.id)!;
    expect(push.body).toMatchObject({ name: 'BRIDGE_SECRET', value, fingerprint: credential.fingerprint, replaceFingerprint: null });
    expect(start.replies.at(-1)!.type).toBe('snapshot.request');
    const itemId = randomUUID();
    await vault.send('credential.ack', { ccId: credential.id, itemId, status: 'saved', fingerprint: credential.fingerprint, vaultFingerprint: credential.fingerprint, updatedAt: null, cloudPending: false, detail: null });
    const shared = { itemId: randomUUID(), title: 'GitHub deploy token', kind: 'github', envVar: null, value: secret('gh'), updatedAt: null, ccId: null, authority: 'myvault' };
    expect((await vault.send('snapshot.part', { part: 1, final: false, items: [shared] })).replies).toEqual([]);
    const done = await vault.send('snapshot.part', { part: 2, final: true, items: [{ itemId, title: 'BRIDGE_SECRET', kind: 'other', envVar: null, value, updatedAt: null, ccId: credential.id, authority: 'control-center' }, { junk: true }] });
    // One unreadable item: the snapshot is not trusted to say anything else is gone.
    expect(done.replies).toEqual([{ type: 'snapshot.result', body: { imported: 1, updated: 0, unchanged: 1, pending: 0, conflicts: 0, rejected: 1, missing: 0 } }]);
    const list = await t.api('GET', '/api/credentials');
    const listed = JSON.stringify(list.body);
    expect(listed).not.toContain(value);
    expect(listed).not.toContain(shared.value);
    expect(list.body.find((c: { id: string }) => c.id === credential.id).vault).toMatchObject({ state: 'synced', origin: ORIGIN, itemId });
    expect(list.body.find((c: { source: string }) => c.source === 'myvault')).toMatchObject({ kind: 'github', repositoryIds: [], vault: { state: 'synced' } });
    expect((await vault.send('bye', {})).status).toBe(200);
    expect((await t.api('GET', '/api/vault-bridge/status')).body.sessions).toEqual([]);
    const events = await t.api('GET', `/api/credentials/${credential.id}/events`);
    expect(events.body.map((e: { operation: string }) => e.operation)).toEqual(expect.arrayContaining(['generate', 'ack']));
    expect(JSON.stringify(events.body)).not.toContain(value);
  });

  it('re-sends the same value after a lost acknowledgement, and marks missing only after a complete snapshot', async () => {
    await t.api('POST', '/api/vault-bridge/origins', { origin: ORIGIN });
    const { credential } = await t.services.credentials.generate({ name: 'LOST_ACK', kind: 'other', envVar: null, description: '', bytes: 32, encoding: 'base64url', repositoryIds: [], taskId: null });
    const first = new FakeVault(t);
    await first.connect();
    const one = (await first.send('sync.start', {})).replies.find((r) => r.body.ccId === credential.id)!;
    // MyVault saved it but the tab closed before the acknowledgement reached us.
    await t.api('DELETE', `/api/vault-bridge/sessions/${first.sessionId}`);
    expect(t.services.credentials.get(credential.id)!.vault!.state).toBe('pending_push');
    const second = new FakeVault(t);
    await second.connect();
    const two = (await second.send('sync.start', {})).replies.find((r) => r.body.ccId === credential.id)!;
    expect(two.body.value).toBe(one.body.value);
    expect(two.body.fingerprint).toBe(credential.fingerprint);
    // An interrupted snapshot (no final part) declares nothing missing.
    const before = await missingCount(t);
    await second.send('snapshot.part', { part: 1, final: false, items: [] });
    await second.send('bye', {});
    expect(await missingCount(t)).toBe(before);
    // A complete snapshot without the imported GitHub item marks it missing and keeps it.
    const third = new FakeVault(t);
    await third.connect();
    await third.send('sync.start', {});
    const result = await third.send('snapshot.part', { part: 1, final: true, items: [] });
    expect(result.replies[0]!.body.missing).toBeGreaterThanOrEqual(1);
    const github = (await t.api('GET', '/api/credentials')).body.find((c: { kind: string; source: string }) => c.source === 'myvault' && c.kind === 'github');
    expect(github.vault.state).toBe('missing');
  });

  it('closes the session on a replayed, forged, out-of-order or unexpected message', async () => {
    await t.api('POST', '/api/vault-bridge/origins', { origin: ORIGIN });
    const vault = new FakeVault(t);
    await vault.connect();
    const start = await vault.send('sync.start', {});
    const replay = await vault.relay(start.envelope);
    expect([replay.status, replay.error]).toEqual([400, 'PROTOCOL']);
    expect((await vault.send('bye', {})).error).toBe('NO_SESSION');

    const other = new FakeVault(t);
    await other.connect();
    expect((await other.send('snapshot.part', { part: 1, final: true, items: [] })).error).toBe('PROTOCOL');

    const third = new FakeVault(t);
    await third.connect();
    await third.send('sync.start', {});
    expect((await third.send('credential.ack', { ccId: 'never-pushed', itemId: null, status: 'saved', fingerprint: null, vaultFingerprint: null, updatedAt: null, cloudPending: false, detail: null })).error).toBe('PROTOCOL');

    // Two copies of one envelope sent together: exactly one is accepted.
    const twin = new FakeVault(t);
    await twin.connect();
    const env = await twin.channel.seal('sync.start', {});
    const [a, b] = await Promise.all([twin.relay(env).catch(() => null), twin.relay(env).catch(() => null)]);
    expect([a?.status, b?.status].filter((x) => x === 200)).toHaveLength(1);

    const fourth = new FakeVault(t);
    await fourth.connect();
    await fourth.send('sync.start', {});
    expect((await fourth.send('snapshot.part', { part: 2, final: true, items: [] })).error).toBe('PROTOCOL');

    const fifth = new FakeVault(t);
    await fifth.connect();
    const big = await t.app.inject({ method: 'POST', url: `/api/vault-bridge/sessions/${fifth.sessionId}/messages`, headers: { host: '127.0.0.1:4317', authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, payload: JSON.stringify({ envelope: 'x'.repeat(600 * 1024) }) });
    expect(big.statusCode).toBe(413);
  });

  it('drops sessions on restart while pending pushes survive', async () => {
    await t.api('POST', '/api/vault-bridge/origins', { origin: ORIGIN });
    const { credential } = await t.services.credentials.generate({ name: 'SURVIVES_RESTART', kind: 'other', envVar: null, description: '', bytes: 32, encoding: 'base64url', repositoryIds: [], taskId: null });
    const conflicted = (await t.services.credentials.generate({ name: 'CONFLICTED', kind: 'other', envVar: null, description: '', bytes: 32, encoding: 'base64url', repositoryIds: [], taskId: null })).credential;
    const [cPush] = (await t.services.credentials.pendingPushes(ORIGIN, VAULT, 100)).filter((p) => p.credentialId === conflicted.id);
    t.services.credentials.recordPushAck(conflicted.id, ORIGIN, VAULT, cPush!.fingerprint, ack({ fingerprint: cPush!.fingerprint }));
    await t.services.credentials.applyVaultItem(ORIGIN, VAULT, { itemId: randomUUID(), title: 'CONFLICTED', kind: 'other', envVar: null, value: secret('edited'), updatedAt: null, ccId: conflicted.id, authority: 'control-center' });
    expect(t.services.credentials.get(conflicted.id)!.vault!.state).toBe('conflict');
    const vault = new FakeVault(t);
    await vault.connect();
    const dataDir = t.dataDir;
    await t.close();
    t = await createTestApp({ dataDir });
    vault.t = t;
    expect(t.services.credentials.get(credential.id)!.vault).toMatchObject({ state: 'pending_push' });
    expect(t.services.credentials.get(conflicted.id)!.vault).toMatchObject({ state: 'conflict' });
    const status = (await t.api('GET', '/api/vault-bridge/status')).body;
    expect(status).toMatchObject({ sessions: [], origins: [expect.objectContaining({ origin: ORIGIN })] });
    expect(status.pendingPush).toBeGreaterThanOrEqual(1);
    expect(status.conflicts).toBeGreaterThanOrEqual(1);
    expect((await vault.send('sync.start', {})).error).toBe('NO_SESSION');
    const again = new FakeVault(t);
    await again.connect();
    const push = (await again.send('sync.start', {})).replies.find((r) => r.body.ccId === credential.id)!;
    expect(push.body.fingerprint).toBe(credential.fingerprint);
  }, 60_000);
});

describe('bridge session lifetime', () => {
  it('expires idle and old sessions and caps how many are open', async () => {
    const { store, broker } = brokerHarness();
    let clock = 1_000_000;
    const bridge = new VaultBridgeService(store, broker, { idleMs: 1000, maxMs: 5000, maxSessions: 2, now: () => clock });
    bridge.trustOrigin(ORIGIN);
    bridge.trustOrigin('https://second.example');
    bridge.trustOrigin('https://third.example');
    const open = async (origin: string) => bridge.open({ origin, vaultId: VAULT, publicKey: (await generateBridgeKeyPair()).publicKey });
    const a = await open(ORIGIN);
    await open('https://second.example');
    await expect(open('https://third.example')).rejects.toMatchObject({ code: 'LIMIT' });
    clock += 1500;
    expect(bridge.status().sessions).toEqual([]);
    await expect(bridge.message(a.sessionId, {})).rejects.toMatchObject({ code: 'NO_SESSION' });
    // A reconnect from the same origin replaces its previous session.
    const b = await open(ORIGIN);
    const c = await open(ORIGIN);
    expect(bridge.status().sessions.map((s) => s.id)).toEqual([c.sessionId]);
    expect(b.sessionId).not.toBe(c.sessionId);
    bridge.untrustOrigin(ORIGIN);
    expect(bridge.status().sessions).toEqual([]);
    await expect(open(ORIGIN)).rejects.toMatchObject({ code: 'UNTRUSTED_ORIGIN' });
  });
});

describe('credential.generate through the tool layer', () => {
  let t: TestApp;
  let repoId: string;

  beforeAll(async () => {
    t = await createTestApp();
    repoId = await addRepo(t, await makeRepo({ files: { 'wrangler.toml': 'name = "fixture"\n' } }));
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  it('returns metadata only, scoped to the repository, and never regenerates', async () => {
    const first = await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'credential.generate', input: { name: 'APP_SESSION_KEY' } });
    expect(first.body.result.ok).toBe(true);
    expect(first.body.result.output).toMatchObject({ name: 'APP_SESSION_KEY', created: true, repositoryIds: [repoId], vaultSync: 'pending_push' });
    const value = (await t.services.credentials.value('APP_SESSION_KEY', repoId, { includeUnsynced: true }))!;
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await t.services.credentials.value('APP_SESSION_KEY', 'another-repository', { includeUnsynced: true })).toBeNull();
    const again = await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'credential.generate', input: { name: 'APP_SESSION_KEY', bytes: 64 } });
    expect(again.body.result.output).toMatchObject({ created: false, fingerprint: first.body.result.output.fingerprint });
    expect(await t.services.credentials.value('APP_SESSION_KEY', repoId, { includeUnsynced: true })).toBe(value);
    // An agent in a Cloudflare Worker stage may call it too; the value still never comes back.
    const agent = await t.services.tools.invoke({ capability: 'credential.generate', input: { name: 'WEBHOOK_SIGNING', bytes: 48, encoding: 'hex' }, origin: 'agent', scope: { ...operatorScope(t.services, repoId, 'cloudflare-worker'), stageLevel: 2, sessionId: null, escalated: new Set() } });
    expect(agent.result.ok).toBe(true);
    const hex = (await t.services.credentials.value('WEBHOOK_SIGNING', repoId, { includeUnsynced: true }))!;
    expect(hex).toMatch(/^[0-9a-f]{96}$/);
    const everything = [
      JSON.stringify(first.body),
      JSON.stringify(again.body),
      ToolService.formatForModel(agent),
      JSON.stringify((await t.api('GET', '/api/tool-executions?limit=50')).body),
      JSON.stringify((await t.api('GET', '/api/credentials')).body),
      JSON.stringify(t.services.db.prepare('SELECT * FROM tool_executions').all()),
      JSON.stringify(t.services.db.prepare('SELECT * FROM credential_events').all()),
    ].join('\n');
    expect(everything).not.toContain(value);
    expect(everything).not.toContain(hex);
    const bad = await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'credential.generate', input: { name: 'has spaces' } });
    expect(bad.body.result.error.code).toBe('INVALID_INPUT');
  });
});

/**
 * A stand-in for Wrangler in the repository's node_modules/.bin: it records
 * its arguments, whether the management token arrived, whether the secret
 * leaked into its environment, and stores what it read on stdin — so a test
 * can prove the value travelled by stdin and nowhere else.
 */
const FAKE_WRANGLER = `
const fs = require('fs');
const state = process.env.FAKE_WRANGLER_STATE;
const mode = fs.existsSync(state + '.mode') ? fs.readFileSync(state + '.mode', 'utf8').trim() : 'ok';
const log = (entry) => fs.appendFileSync(state + '.log', JSON.stringify(entry) + '\\n');
const args = process.argv.slice(2);
const data = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : {};
const envOf = (a) => (a.includes('--env') ? a[a.indexOf('--env') + 1] : 'default');
if (args[0] === 'secret' && args[1] === 'put') {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    const value = Buffer.concat(chunks).toString('utf8');
    log({ args, token: Boolean(process.env.CLOUDFLARE_API_TOKEN), envHasValue: Object.values(process.env).includes(value) });
    if (mode === 'auth') { console.error('Authentication error [code: 10000]: check CLOUDFLARE_API_TOKEN'); process.exit(1); }
    data[args[2] + '@' + envOf(args)] = value;
    fs.writeFileSync(state, JSON.stringify(data));
    console.log('Success! Uploaded secret ' + args[2]);
  });
} else if (args[0] === 'secret' && args[1] === 'list') {
  log({ args });
  const env = envOf(args);
  console.log(JSON.stringify(mode === 'unverified' ? [] : Object.keys(data).filter((k) => k.endsWith('@' + env)).map((k) => ({ name: k.split('@')[0], type: 'secret_text' }))));
} else {
  log({ args });
  console.log('4.129.0');
}
`;

function fakeWranglerFiles(): Record<string, string> {
  return {
    'node_modules/.bin/fake-wrangler.cjs': FAKE_WRANGLER,
    'node_modules/.bin/wrangler.cmd': '@node "%~dp0fake-wrangler.cjs" %*\r\n',
    'node_modules/.bin/wrangler': '#!/bin/sh\nexec node "$(dirname "$0")/fake-wrangler.cjs" "$@"\n',
  };
}

describe('project-local tools', () => {
  it('routes to a wrangler in the repository when none is on PATH', async () => {
    const state = path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-local-wrangler-')), 'state.json');
    // PATH holds node and the system shell only: the global check cannot find wrangler.
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PATH'));
    env.PATH = [path.dirname(process.execPath), ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : ['/bin', '/usr/bin'])].join(path.delimiter);
    const t = await createTestApp({ baseEnv: { ...env, FAKE_WRANGLER_STATE: state } });
    try {
      const repoPath = await makeRepo({ files: { 'wrangler.toml': 'name = "fixture"\n' } });
      mkdirSync(path.join(repoPath, 'node_modules', '.bin'), { recursive: true });
      for (const [file, content] of Object.entries(fakeWranglerFiles())) writeFileSync(path.join(repoPath, file), content);
      if (process.platform !== 'win32') chmodSync(path.join(repoPath, 'node_modules', '.bin', 'wrangler'), 0o755);
      const repositoryId = await addRepo(t, repoPath);
      // The global check (no folder) cannot see it.
      expect((await t.services.tools.health.check('wrangler', { force: true })).installed).toBe(false);
      const r = await t.api('POST', '/api/tools/call', { repositoryId, capability: 'cloudflare.whoami', input: {} });
      expect(r.body.result.ok).toBe(true);
      expect(r.body.execution.providerId).toBe('wrangler');
      expect(readFileSync(`${state}.log`, 'utf8')).toContain('"whoami"');
    } finally {
      await t.close();
    }
  }, 60_000);
});

describe('cloudflare.secret_put', () => {
  let t: TestApp;
  let repoId: string;
  let repoPath: string;
  const state = path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-fake-wrangler-')), 'state.json');
  const readLog = (): Array<{ args: string[]; token?: boolean; envHasValue?: boolean }> => (existsSync(`${state}.log`) ? readFileSync(`${state}.log`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const stored = (): Record<string, string> => (existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {});
  const mode = (m: 'ok' | 'auth' | 'unverified') => writeFileSync(`${state}.mode`, m);
  /** Level 4 and 5 need a person's confirmation; tests confirm unless they check that it is asked for. */
  const put = (input: Record<string, unknown>, confirm = true) => t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'cloudflare.secret_put', input, ...(confirm ? { confirmation: 'cloudflare.secret_put' } : {}) });

  beforeAll(async () => {
    t = await createTestApp({ baseEnv: { ...process.env, FAKE_WRANGLER_STATE: state } });
    repoPath = await makeRepo({ files: { 'wrangler.toml': 'name = "fixture"\n' } });
    mkdirSync(path.join(repoPath, 'node_modules', '.bin'), { recursive: true });
    for (const [file, content] of Object.entries(fakeWranglerFiles())) writeFileSync(path.join(repoPath, file), content);
    if (process.platform !== 'win32') chmodSync(path.join(repoPath, 'node_modules', '.bin', 'wrangler'), 0o755);
    repoId = await addRepo(t, repoPath);
    await t.api('POST', '/api/credentials', { name: 'cf-management', kind: 'cloudflare', value: secret('cf-token'), repositoryIds: [repoId] });
  }, 60_000);

  afterAll(async () => {
    await t.close();
  });

  it('refuses a generated secret MyVault has not saved, then deploys the same value by stdin', async () => {
    mode('ok');
    await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'credential.generate', input: { name: 'RUNTIME_SECRET' } });
    const value = (await t.services.credentials.value('RUNTIME_SECRET', repoId, { includeUnsynced: true }))!;
    // Until MyVault has it, no tool path may use it: not a header, not an injected variable.
    const viaHttp = await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'http.request', input: { url: 'http://127.0.0.1:9/', method: 'GET', auth: { credential: 'RUNTIME_SECRET' } } });
    expect(viaHttp.body.result.error.code).toBe('AUTH_REQUIRED');
    expect(await t.services.credentials.value('RUNTIME_SECRET', repoId)).toBeNull();
    const blocked = await put({ credential: 'RUNTIME_SECRET', secretName: 'SESSION_SECRET', environment: 'staging' });
    expect(blocked.body.result.ok).toBe(false);
    expect(blocked.body.result.summary).toBe(VAULT_SYNC_REQUIRED);
    expect(readLog().filter((e) => e.args[1] === 'put')).toEqual([]);
    expect((await t.api('GET', `/api/credentials/RUNTIME_SECRET/events`)).body.map((e: { operation: string }) => e.operation)).toContain('deploy_blocked');

    // MyVault saves it (what the bridge records on a good acknowledgement).
    const [push] = (await t.services.credentials.pendingPushes(ORIGIN, VAULT, 100)).filter((p) => p.name === 'RUNTIME_SECRET');
    t.services.credentials.recordPushAck(push!.credentialId, ORIGIN, VAULT, push!.fingerprint, ack({ fingerprint: push!.fingerprint }));

    const done = await put({ credential: 'RUNTIME_SECRET', secretName: 'SESSION_SECRET', environment: 'staging' });
    expect(done.body.result).toMatchObject({ ok: true, output: { secretName: 'SESSION_SECRET', environment: 'staging', verified: true } });
    expect(done.body.execution.permissionLevel).toBe(4);
    expect(stored()['SESSION_SECRET@staging']).toBe(value);
    const call = readLog().find((e) => e.args[1] === 'put')!;
    expect(call.args).toEqual(['secret', 'put', 'SESSION_SECRET', '--env', 'staging']);
    expect(call.token).toBe(true);
    expect(call.envHasValue).toBe(false);
    const everything = JSON.stringify(done.body) + JSON.stringify(t.services.db.prepare('SELECT * FROM tool_executions').all()) + readFileSync(`${state}.log`, 'utf8');
    expect(everything).not.toContain(value);
  });

  it('keeps production behind a typed approval', async () => {
    mode('ok');
    const r = await put({ credential: 'RUNTIME_SECRET', secretName: 'SESSION_SECRET', environment: 'production' }, false);
    expect(r.body.decision).toBe('approval');
    expect(r.body.execution.permissionLevel).toBe(5);
    expect(stored()['SESSION_SECRET@production']).toBeUndefined();
    const approved = await put({ credential: 'RUNTIME_SECRET', secretName: 'SESSION_SECRET', environment: 'production' });
    expect(approved.body.result.ok).toBe(true);
  });

  it('keeps the same value through an auth failure and an unverified write', async () => {
    const before = t.services.credentials.get('RUNTIME_SECRET')!.fingerprint;
    const value = (await t.services.credentials.value('RUNTIME_SECRET', repoId))!;
    mode('auth');
    const auth = await put({ credential: 'RUNTIME_SECRET', secretName: 'OTHER_SECRET', environment: 'staging' });
    expect(auth.body.result.error.code).toBe('AUTH_REQUIRED');
    mode('unverified');
    const unverified = await put({ credential: 'RUNTIME_SECRET', secretName: 'OTHER_SECRET', environment: 'staging' });
    expect(unverified.body.result).toMatchObject({ ok: false, output: { verified: false } });
    expect(unverified.body.result.summary).toMatch(/^Deployment unverified/);
    mode('ok');
    const retry = await put({ credential: 'RUNTIME_SECRET', secretName: 'OTHER_SECRET', environment: 'staging' });
    expect(retry.body.result.ok).toBe(true);
    expect(stored()['OTHER_SECRET@staging']).toBe(value);
    expect(t.services.credentials.get('RUNTIME_SECRET')!.fingerprint).toBe(before);
  });

  it('refuses a credential outside the repository scope', async () => {
    mode('ok');
    await t.services.credentials.create({ name: 'elsewhere', kind: 'other', value: secret('x'), repositoryIds: ['another-repository'] });
    const r = await put({ credential: 'elsewhere', secretName: 'X', environment: 'staging' });
    expect(r.body.result.error.code).toBe('INVALID_INPUT');
  });
});
