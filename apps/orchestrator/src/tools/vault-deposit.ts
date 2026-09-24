import { randomUUID } from 'node:crypto';
import type { webcrypto } from 'node:crypto';
import type { VaultBridgeStatus } from '@acc/shared';
import type { Bus } from '../bus.js';
import { now } from '../store/store.js';
import type { CredentialBroker } from './credentials.js';
import type { DepositRecord, DepositTargetRecord, ToolStore } from './store.js';
import { depositKeyId, newSessionId, sealDeposit } from './vault-bridge-protocol.js';

/**
 * The MyVault delivery box (docs/systems/credential-broker.md, "Delivery box";
 * plan: docs/plans/secret-delivery-flow.md).
 *
 * MyVault sets a box up during a bridge session: its delivery public key and a
 * deliver-only sender token for its Worker, both inside the sealed channel. From
 * then on a newly generated secret does not wait for MyVault to be unlocked: it
 * is sealed to the delivery key, signed with this orchestrator's identity, and
 * left on MyVault's Worker, which stores ciphertext it cannot open. Once the
 * Worker has stored it the secret is saved for MyVault, so the vault-before-
 * deploy gate lets it go (`synced_fingerprint`, state `deposited`). MyVault
 * collects it when next unlocked and leaves a receipt, read here to mark the
 * link `synced` — or, if MyVault could not open it, to hold the secret again so
 * the bridge delivers it instead.
 *
 * Only brand-new generated secrets travel this way; replacements and conflicts
 * stay on the bridge, where they can be settled. Nothing here ever logs,
 * returns or stores a value outside the broker's ciphertext.
 */

const TOKEN_PATTERN = /^mvx_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/;
const tokenBinding = (origin: string) => `vault-deposit-token:${origin}`;
/** Deposit ids per receipt request: MyVault's Worker accepts at most 90 (D1 binds 100 values per query). */
const RECEIPT_BATCH = 90;

export interface VaultDepositOptions {
  fetch: typeof fetch;
  /** How often stored deposits are checked for a receipt. */
  pollMs: number;
  /** Each call to MyVault's Worker. */
  requestTimeoutMs: number;
  bus?: Bus;
}

export interface DepositOffer {
  origin: string;
  vaultId: string;
  keyId: string;
  publicKey: string;
  senderId: string;
  token: string;
}

type Identity = () => Promise<{ signingKey: webcrypto.CryptoKey; publicKey: string }>;

export class VaultDepositService {
  private readonly opts: VaultDepositOptions;
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private pollTimer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private lastPollAt = 0;
  private stopped = false;

  constructor(
    private readonly store: ToolStore,
    private readonly broker: CredentialBroker,
    private readonly identity: Identity,
    opts: Partial<VaultDepositOptions> = {},
  ) {
    this.opts = { fetch: globalThis.fetch, pollMs: 60_000, requestTimeoutMs: 15_000, ...opts };
    // Deposits left before a restart are still owed a receipt check.
    if (this.store.deposits({ status: 'stored' }).length || this.store.deposits({ status: 'sending' }).length) this.schedule(5_000);
  }

  summary(): VaultBridgeStatus['delivery'] {
    const open = this.store.deposits().filter((d) => d.status === 'stored' || d.status === 'sending');
    return this.store.depositTargets().map((t) => ({ origin: t.origin, vaultId: t.vaultId, keyId: t.keyId, lastDepositAt: t.lastDepositAt, lastError: t.lastError, waiting: open.filter((d) => d.origin === t.origin).length }));
  }

  /** What a bridge session tells MyVault about its box here, so MyVault offers one only when needed. */
  offerState(origin: string, vaultId: string): { accepted: boolean; keyId: string | null; senderId: string | null; healthy: boolean } {
    const t = this.store.depositTarget(origin);
    if (!t || t.vaultId !== vaultId) return { accepted: false, keyId: null, senderId: t?.senderId ?? null, healthy: false };
    // Only a refused credential asks MyVault for a new one; a busy or unreachable Worker does not.
    return { accepted: true, keyId: t.keyId, senderId: t.senderId, healthy: t.lastErrorKind !== 'auth' };
  }

  /**
   * The operator stopped trusting this MyVault address: its box goes, nothing
   * more is sent there, and secrets waiting in it are held again for the bridge.
   */
  forgetOrigin(origin: string): void {
    for (const d of this.store.deposits().filter((x) => x.origin === origin && (x.status === 'sending' || x.status === 'stored'))) {
      this.refused(d, 'This MyVault address is no longer trusted');
    }
    this.store.removeDepositTarget(origin);
  }

  /** MyVault's offer, from inside an authenticated bridge session. */
  async acceptOffer(offer: DepositOffer): Promise<void> {
    const match = TOKEN_PATTERN.exec(offer.token);
    if (!match || match[1] !== offer.senderId) throw new Error('The delivery credential is not valid');
    if ((await depositKeyId(offer.publicKey)) !== offer.keyId) throw new Error('The delivery key does not match its id');
    const ts = now();
    const current = this.store.depositTarget(offer.origin);
    this.store.upsertDepositTarget({
      origin: offer.origin,
      vaultId: offer.vaultId,
      keyId: offer.keyId,
      publicKey: offer.publicKey,
      senderId: offer.senderId,
      sealedToken: await this.broker.sealValue(offer.token, tokenBinding(offer.origin)),
      lastError: null,
      lastErrorKind: null,
      lastDepositAt: current?.lastDepositAt ?? null,
      createdAt: current?.createdAt ?? ts,
      updatedAt: ts,
    });
    // Secrets that were waiting for a box can go now.
    for (const link of this.store.listVaultLinks()) if (this.eligible(link.credentialId)) void this.deposit(link.credentialId);
  }

  /** The box a brand-new generated secret would go to, or null when it must wait for the bridge. */
  eligible(credentialId: string): DepositTargetRecord | null {
    const r = this.store.credential(credentialId);
    const link = r ? this.store.vaultLink(r.id) : null;
    if (!r || !link || link.authority !== 'control-center' || link.state !== 'pending_push') return null;
    // Never held by MyVault, never agreed: a first value only.
    if (link.itemId !== null || link.syncedFingerprint !== null || link.replaceVaultFingerprint !== null) return null;
    // Only a box at an address the operator still trusts, whose credential MyVault has not refused.
    const trusted = new Set(this.store.listTrustedOrigins().map((o) => o.origin));
    const targets = this.store
      .depositTargets()
      .filter((t) => trusted.has(t.origin) && t.lastErrorKind !== 'auth' && (link.origin === null || (t.origin === link.origin && t.vaultId === link.vaultId)));
    const refused = new Set(this.store.deposits({ credentialId }).filter((d) => d.status === 'refused').map((d) => d.origin));
    return targets.find((t) => !refused.has(t.origin)) ?? null;
  }

  /** Leave the secret in a box. True once MyVault's Worker has stored it. One attempt per secret at a time. */
  deposit(credentialId: string): Promise<boolean> {
    const running = this.inFlight.get(credentialId);
    if (running) return running;
    const attempt = this.depositOnce(credentialId).finally(() => this.inFlight.delete(credentialId));
    this.inFlight.set(credentialId, attempt);
    return attempt;
  }

  /**
   * For the deploy gate: when a box exists, wait (bounded) for the secret to be
   * stored in it rather than refusing a deployment a moment too early.
   */
  async ensureDeposited(credentialId: string, timeoutMs = 20_000): Promise<boolean> {
    if (!this.inFlight.has(credentialId) && !this.eligible(credentialId)) return false;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([this.deposit(credentialId), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A receipt check now, when someone is looking (the dashboard's status), at
   * most every 10 s; the timer alone checks once a minute.
   */
  pollSoon(): void {
    if (this.stopped || this.polling || Date.now() - this.lastPollAt < 10_000) return;
    if (!this.store.deposits({ status: 'stored' }).length && !this.store.deposits({ status: 'sending' }).length) return;
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private async depositOnce(credentialId: string): Promise<boolean> {
    const target = this.eligible(credentialId);
    const r = this.store.credential(credentialId);
    if (!target || !r) return false;
    const reuse = this.store.deposits({ credentialId }).find((d) => d.origin === target.origin && d.fingerprint === r.fingerprint && d.status === 'sending');
    const ts = now();
    // The id is reserved before the first attempt, so a retry after a lost answer is the same deposit.
    const record: DepositRecord = reuse ?? { id: newSessionId(), credentialId, origin: target.origin, vaultId: target.vaultId, fingerprint: r.fingerprint, status: 'sending', receiptStatus: null, detail: null, createdAt: ts, updatedAt: ts };
    if (!reuse) this.store.upsertDeposit(record);
    try {
      const value = await this.broker.openValue({ ciphertext: r.ciphertext, iv: r.iv, tag: r.tag }, r.id);
      const sealed = await sealDeposit({
        id: record.id,
        vaultId: target.vaultId,
        recipientPublicKey: target.publicKey,
        identity: await this.identity(),
        body: { ccId: r.id, name: r.name, kind: r.kind, envVar: r.envVar, description: r.description, value, fingerprint: r.fingerprint, createdAt: r.createdAt },
      });
      const res = await this.call(target, '/api/v1/deposits', { method: 'POST', body: JSON.stringify({ id: record.id, sealed }) });
      if (res.status === 200 || res.status === 201) {
        this.stored(record, target);
        return true;
      }
      if (res.status === 401) this.store.noteDepositTarget(target.origin, { lastError: 'MyVault no longer accepts deliveries from this Control Center. Connect MyVault once to set the delivery box up again.', lastErrorKind: 'auth' });
      else if (res.status === 409) this.store.upsertDeposit({ ...record, status: 'refused', detail: 'The delivery box already holds another deposit with this id', updatedAt: now() });
      else if (res.status === 429) this.store.noteDepositTarget(target.origin, { lastError: 'MyVault’s delivery box is full or busy: unlock MyVault to collect what is waiting.', lastErrorKind: 'transient' });
      else this.store.noteDepositTarget(target.origin, { lastError: `MyVault’s delivery box answered ${res.status}`, lastErrorKind: 'transient' });
      this.schedule();
      return false;
    } catch (error) {
      this.store.noteDepositTarget(target.origin, { lastError: `MyVault’s delivery box could not be reached (${error instanceof Error ? error.name : 'error'})`, lastErrorKind: 'transient' });
      this.schedule();
      return false;
    }
  }

  private stored(record: DepositRecord, target: DepositTargetRecord): void {
    const ts = now();
    const r = this.store.credential(record.credentialId);
    const link = r ? this.store.vaultLink(r.id) : null;
    this.store.transaction(() => {
      this.store.upsertDeposit({ ...record, status: 'stored', updatedAt: ts });
      // Saved for MyVault: the gate may release exactly this value.
      if (r && link && link.state === 'pending_push' && r.fingerprint === record.fingerprint) {
        this.store.upsertVaultLink({ ...link, origin: target.origin, vaultId: target.vaultId, state: 'deposited', syncedFingerprint: record.fingerprint, lastError: null, updatedAt: ts });
      }
    });
    this.store.noteDepositTarget(target.origin, { lastError: null, lastErrorKind: null, lastDepositAt: ts });
    if (r) this.event(r.id, r.name, 'deposit', 'ok', target.origin, 'Sealed in MyVault’s delivery box');
    this.publish(record.credentialId);
    this.schedule();
  }

  /** Receipts for stored deposits; retries for deposits whose answer was lost. */
  async poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.lastPollAt = Date.now();
    this.polling = this.pollOnce().finally(() => (this.polling = null));
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    // Retries stop at the first failure per box in a pass: MyVault's Worker limits requests per
    // address, and the vault's own sync from the same address shares that limit.
    const failing = new Set<string>();
    for (const d of this.store.deposits({ status: 'sending' })) {
      if (failing.has(d.origin)) continue;
      const target = this.store.depositTarget(d.origin);
      // A refused credential waits for MyVault's next offer; the deposit stays reserved.
      if (target?.lastErrorKind === 'auth') continue;
      if (!this.eligible(d.credentialId)) {
        this.store.upsertDeposit({ ...d, status: 'refused', detail: 'No longer needed', updatedAt: now() });
        continue;
      }
      if (!(await this.deposit(d.credentialId))) failing.add(d.origin);
    }
    // Receipts in one request per box for up to 90 deposits (D1 binds at most 100 values per query).
    const stored = this.store.deposits({ status: 'stored' });
    for (const origin of new Set(stored.map((d) => d.origin))) {
      const target = this.store.depositTarget(origin);
      if (!target) continue;
      const waiting = stored.filter((d) => d.origin === origin);
      for (let i = 0; i < waiting.length; i += RECEIPT_BATCH) {
        const batch = waiting.slice(i, i + RECEIPT_BATCH);
        try {
          const res = await this.call(target, '/api/v1/deposits/receipts', { method: 'POST', body: JSON.stringify({ ids: batch.map((d) => d.id) }) });
          if (res.status !== 200) break;
          const body = (await res.json()) as { deposits?: Array<{ id?: string; status?: string; receipt?: { status?: string; itemId?: string | null; detail?: string | null } | null }> };
          const byId = new Map((body.deposits ?? []).map((row) => [row.id, row]));
          for (const d of batch) {
            const row = byId.get(d.id);
            if (!row) this.refused(d, 'The delivery box no longer holds this deposit');
            else if (row.status === 'collected' && row.receipt) this.collected(d, row.receipt);
          }
        } catch {
          break; // the next poll tries again
        }
      }
    }
  }

  private collected(d: DepositRecord, receipt: { status?: string; itemId?: string | null; detail?: string | null }): void {
    const ts = now();
    const r = this.store.credential(d.credentialId);
    const link = r ? this.store.vaultLink(r.id) : null;
    if (receipt.status === 'saved' || receipt.status === 'unchanged') {
      this.store.transaction(() => {
        this.store.upsertDeposit({ ...d, status: 'collected', receiptStatus: receipt.status!, updatedAt: ts });
        if (r && link && link.state === 'deposited' && r.fingerprint === d.fingerprint) {
          const itemId = typeof receipt.itemId === 'string' && receipt.itemId.length <= 100 ? receipt.itemId : link.itemId;
          this.store.upsertVaultLink({ ...link, itemId, state: 'synced', vaultFingerprint: d.fingerprint, firstSyncedAt: link.firstSyncedAt ?? ts, lastSyncedAt: ts, lastError: null, updatedAt: ts });
        }
      });
      if (r) this.event(r.id, r.name, 'collected', 'ok', d.origin, 'Collected into MyVault');
      this.publish(d.credentialId);
      return;
    }
    this.refused(d, receipt.detail ?? `MyVault could not keep it (${receipt.status ?? 'unknown'})`, receipt.status ?? 'error');
  }

  /** MyVault did not keep it: hold the secret again, so the bridge delivers it instead. */
  private refused(d: DepositRecord, detail: string, receiptStatus: string | null = null): void {
    const ts = now();
    const r = this.store.credential(d.credentialId);
    const link = r ? this.store.vaultLink(r.id) : null;
    this.store.transaction(() => {
      this.store.upsertDeposit({ ...d, status: 'refused', receiptStatus, detail: detail.slice(0, 300), updatedAt: ts });
      if (r && link && link.state === 'deposited' && link.syncedFingerprint === d.fingerprint) {
        this.store.upsertVaultLink({ ...link, state: 'pending_push', syncedFingerprint: null, lastError: `The delivery box did not reach MyVault: ${detail}`.slice(0, 300), updatedAt: ts });
      }
    });
    if (r) this.event(r.id, r.name, 'collected', 'failed', d.origin, detail);
    this.publish(d.credentialId);
  }

  private async call(target: DepositTargetRecord, path: string, init: { method: string; body?: string }): Promise<Response> {
    const token = await this.broker.openValue(target.sealedToken, tokenBinding(target.origin));
    return this.opts.fetch(`${target.origin}${path}`, {
      method: init.method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      ...(init.body ? { body: init.body } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
    });
  }

  private schedule(delayMs = this.opts.pollMs): void {
    if (this.stopped || this.pollTimer) return;
    const due = this.store.deposits({ status: 'stored' }).length + this.store.deposits({ status: 'sending' }).length;
    if (!due) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll().finally(() => this.schedule());
    }, delayMs);
    this.pollTimer.unref();
  }

  private event(credentialId: string, credentialName: string, operation: 'deposit' | 'collected', status: 'ok' | 'failed', target: string, detail: string): void {
    this.store.insertCredentialEvent({ id: randomUUID(), credentialId, credentialName, operation, direction: 'to_vault', status, taskId: null, target, detail, createdAt: now() });
  }

  private publish(credentialId: string): void {
    const credential = this.broker.get(credentialId);
    if (credential) this.opts.bus?.publish({ type: 'credential', credential });
  }
}
