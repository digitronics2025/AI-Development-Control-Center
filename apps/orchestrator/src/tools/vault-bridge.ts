import type { VaultBridgeStatus } from '@acc/shared';
import { z } from 'zod';
import type { CredentialBroker, VaultAck } from './credentials.js';
import type { ToolStore } from './store.js';
import { BRIDGE_LIMITS, BridgeProtocolError, deriveBridgeChannel, generateBridgeKeyPair, newSessionId, type BridgeChannel, type SealedEnvelope } from './vault-bridge-protocol.js';

/**
 * The Control Center end of the MyVault bridge (docs/systems/credential-broker.md,
 * "MyVault bridge"). Sessions live in memory only: a restart drops every key
 * and every session, while the durable link state in SQLite says what is
 * still owed. The dashboard's bridge page relays sealed envelopes to
 * `message` and back; nothing here ever returns a plaintext value.
 *
 * Message flow (MyVault drives it):
 *   mv2cc sync.start          → cc2mv credential.push × n, snapshot.request
 *   mv2cc credential.ack × n  → (nothing)
 *   mv2cc snapshot.part × m   → cc2mv snapshot.result after the final part
 *   mv2cc bye                 → session closed
 */

export class VaultBridgeError extends Error {
  constructor(
    message: string,
    readonly code: 'UNTRUSTED_ORIGIN' | 'NO_SESSION' | 'PROTOCOL' | 'LIMIT' | 'INVALID',
  ) {
    super(message);
  }
}

export const VAULT_BRIDGE_HTTP_STATUS: Record<VaultBridgeError['code'], number> = { UNTRUSTED_ORIGIN: 403, NO_SESSION: 404, PROTOCOL: 400, LIMIT: 429, INVALID: 400 };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const PUSHES_PER_SESSION = 100;

/** A MyVault origin exactly as a browser reports it: https anywhere, http only on this machine. */
export function normalizeVaultOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new VaultBridgeError('Enter the MyVault address, for example https://vault.example.com', 'INVALID');
  }
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!ok || url.username || url.password) throw new VaultBridgeError('MyVault must be an https address (or http on this computer)', 'INVALID');
  return url.origin;
}

const envVar = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
  .nullable();

const itemSchema = z.object({
  itemId: z.string().min(1).max(100),
  title: z.string().max(300),
  kind: z.string().max(20),
  envVar: envVar.catch(null),
  value: z.string().min(1).max(BRIDGE_LIMITS.valueChars),
  updatedAt: z.string().max(40).nullable().catch(null),
  ccId: z.string().min(1).max(100).nullable(),
  authority: z.enum(['myvault', 'control-center']),
});

const partSchema = z.object({ part: z.number().int().min(1).max(1000), final: z.boolean(), items: z.array(z.unknown()).max(BRIDGE_LIMITS.itemsPerPart) });

const ackSchema = z.object({
  ccId: z.string().min(1).max(100),
  itemId: z.string().min(1).max(100).nullable(),
  status: z.enum(['saved', 'unchanged', 'conflict', 'detached', 'error']),
  fingerprint: z.string().regex(/^[0-9a-f]{8}$/).nullable(),
  vaultFingerprint: z.string().regex(/^[0-9a-f]{8}$/).nullable(),
  updatedAt: z.string().max(40).nullable(),
  cloudPending: z.boolean(),
  detail: z.string().max(300).nullable(),
});

export const openSessionSchema = z.object({
  origin: z.string().min(1).max(300),
  vaultId: z.string().regex(/^[\w-]{1,100}$/),
  publicKey: z.string().min(1).max(200),
});

interface Session {
  id: string;
  origin: string;
  vaultId: string;
  channel: BridgeChannel;
  openedAt: number;
  lastActivity: number;
  started: boolean;
  /** Pushed and not yet acknowledged: credential id → fingerprint of the value pushed. */
  inFlight: Map<string, string>;
  nextPart: number;
  itemsSeen: number;
  /** Messages are handled one at a time, in arrival order. */
  queue: Promise<unknown>;
  seen: Set<string>;
  counts: { imported: number; updated: number; unchanged: number; pending: number; conflicts: number; rejected: number };
}

export interface VaultBridgeOptions {
  idleMs: number;
  maxMs: number;
  maxSessions: number;
  now: () => number;
}

export class VaultBridgeService {
  private readonly sessions = new Map<string, Session>();
  private readonly opts: VaultBridgeOptions;

  constructor(
    private readonly store: ToolStore,
    private readonly broker: CredentialBroker,
    opts: Partial<VaultBridgeOptions> = {},
  ) {
    this.opts = { idleMs: 10 * 60_000, maxMs: 30 * 60_000, maxSessions: 4, now: Date.now, ...opts };
  }

  status(): VaultBridgeStatus {
    this.sweep();
    const links = this.store.listVaultLinks();
    return {
      origins: this.store.listTrustedOrigins(),
      sessions: [...this.sessions.values()].map((s) => ({ id: s.id, origin: s.origin, code: s.channel.code, openedAt: new Date(s.openedAt).toISOString(), expiresAt: new Date(this.expiry(s)).toISOString() })),
      pendingPush: links.filter((l) => l.state === 'pending_push').length,
      conflicts: links.filter((l) => l.state === 'conflict').length,
      missing: links.filter((l) => l.state === 'missing' || l.state === 'detached').length,
    };
  }

  /** Operator approval, from the dashboard only: the bridge page itself can never add an origin. */
  trustOrigin(input: string): VaultBridgeStatus {
    this.store.trustOrigin(normalizeVaultOrigin(input));
    return this.status();
  }

  untrustOrigin(input: string): VaultBridgeStatus {
    const origin = normalizeVaultOrigin(input);
    this.store.untrustOrigin(origin);
    for (const s of [...this.sessions.values()]) if (s.origin === origin) this.drop(s);
    return this.status();
  }

  async open(raw: unknown): Promise<{ sessionId: string; publicKey: string; code: string; expiresAt: string }> {
    const input = openSessionSchema.parse(raw);
    const origin = normalizeVaultOrigin(input.origin);
    if (!this.store.listTrustedOrigins().some((o) => o.origin === origin)) {
      throw new VaultBridgeError('This MyVault address is not trusted. Add it under Tools → Credentials → Connect MyVault first.', 'UNTRUSTED_ORIGIN');
    }
    this.sweep();
    // One live session per vault tab origin: a reconnect replaces the old one.
    for (const s of [...this.sessions.values()]) if (s.origin === origin) this.drop(s);
    if (this.sessions.size >= this.opts.maxSessions) throw new VaultBridgeError('Too many MyVault connections are open', 'LIMIT');
    const keys = await generateBridgeKeyPair();
    const sessionId = newSessionId();
    let channel: BridgeChannel;
    try {
      channel = await deriveBridgeChannel({ role: 'control-center', sessionId, privateKey: keys.privateKey, myvaultPublicKey: input.publicKey, controlCenterPublicKey: keys.publicKey });
    } catch {
      throw new VaultBridgeError('The MyVault key was not accepted', 'PROTOCOL');
    }
    const at = this.opts.now();
    const session: Session = { id: sessionId, origin, vaultId: input.vaultId, channel, openedAt: at, lastActivity: at, started: false, inFlight: new Map(), queue: Promise.resolve(), nextPart: 1, itemsSeen: 0, seen: new Set(), counts: { imported: 0, updated: 0, unchanged: 0, pending: 0, conflicts: 0, rejected: 0 } };
    this.sessions.set(sessionId, session);
    this.store.touchOrigin(origin, input.vaultId);
    return { sessionId, publicKey: keys.publicKey, code: channel.code, expiresAt: new Date(this.expiry(session)).toISOString() };
  }

  /** One sealed envelope in, the sealed replies out. Any protocol fault ends the session. */
  async message(sessionId: string, envelope: unknown): Promise<{ replies: SealedEnvelope[]; closed: boolean }> {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session) throw new VaultBridgeError('The MyVault connection is not open. Connect again from MyVault.', 'NO_SESSION');
    const run = session.queue.then(() => this.handleOne(session, envelope));
    session.queue = run.catch(() => undefined);
    return run;
  }

  private async handleOne(session: Session, envelope: unknown): Promise<{ replies: SealedEnvelope[]; closed: boolean }> {
    if (!this.sessions.has(session.id)) throw new VaultBridgeError('The MyVault connection is not open. Connect again from MyVault.', 'NO_SESSION');
    try {
      const { type, body } = await session.channel.open(envelope);
      session.lastActivity = this.opts.now();
      const replies = await this.handle(session, type, body);
      const closed = type === 'bye';
      if (closed) this.drop(session);
      return { replies, closed };
    } catch (error) {
      this.drop(session);
      if (error instanceof VaultBridgeError) throw error;
      // Generic on purpose: never say which check failed or whether an id exists.
      throw new VaultBridgeError(error instanceof BridgeProtocolError ? 'The bridge message was rejected and the connection closed' : 'The bridge message could not be processed and the connection closed', 'PROTOCOL');
    }
  }

  close(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) this.drop(s);
  }

  closeAll(): void {
    for (const s of [...this.sessions.values()]) this.drop(s);
  }

  private expiry(s: Session): number {
    return Math.min(s.lastActivity + this.opts.idleMs, s.openedAt + this.opts.maxMs);
  }

  private sweep(): void {
    const at = this.opts.now();
    for (const s of [...this.sessions.values()]) if (at >= this.expiry(s)) this.drop(s);
  }

  private drop(s: Session): void {
    s.channel.destroy();
    s.inFlight.clear();
    this.sessions.delete(s.id);
  }

  private async handle(s: Session, type: string, body: unknown): Promise<SealedEnvelope[]> {
    if (type !== 'sync.start' && !s.started) throw new VaultBridgeError('The session must start with sync.start', 'PROTOCOL');
    switch (type) {
      case 'sync.start': {
        if (s.started) throw new VaultBridgeError('The session already started', 'PROTOCOL');
        s.started = true;
        const replies: SealedEnvelope[] = [];
        for (const push of await this.broker.pendingPushes(s.origin, s.vaultId, PUSHES_PER_SESSION)) {
          s.inFlight.set(push.credentialId, push.fingerprint);
          replies.push(
            await s.channel.seal('credential.push', {
              ccId: push.credentialId,
              name: push.name,
              kind: push.kind,
              envVar: push.envVar,
              description: push.description,
              value: push.value,
              fingerprint: push.fingerprint,
              replaceFingerprint: push.replaceFingerprint,
            }),
          );
        }
        replies.push(await s.channel.seal('snapshot.request', { pushes: s.inFlight.size }));
        return replies;
      }
      case 'credential.ack': {
        const ack = ackSchema.parse(body);
        const pushed = s.inFlight.get(ack.ccId);
        if (!pushed) throw new VaultBridgeError('Unexpected acknowledgement', 'PROTOCOL');
        s.inFlight.delete(ack.ccId);
        const { ccId, ...rest } = ack;
        this.broker.recordPushAck(ccId, s.origin, s.vaultId, pushed, rest satisfies VaultAck);
        return [];
      }
      case 'snapshot.part': {
        const part = partSchema.parse(body);
        if (part.part !== s.nextPart) throw new VaultBridgeError('Snapshot parts arrived out of order', 'PROTOCOL');
        s.itemsSeen += part.items.length;
        if (s.itemsSeen > BRIDGE_LIMITS.itemsPerSession) throw new VaultBridgeError('Too many shared items in one session', 'LIMIT');
        s.nextPart += 1;
        for (const raw of part.items) {
          const parsed = itemSchema.safeParse(raw);
          if (!parsed.success) {
            s.counts.rejected += 1;
            continue;
          }
          const { outcome, credentialId } = await this.broker.applyVaultItem(s.origin, s.vaultId, { ...parsed.data, kind: parsed.data.kind as never });
          if (credentialId) s.seen.add(credentialId);
          if (outcome === 'imported') s.counts.imported += 1;
          else if (outcome === 'updated') s.counts.updated += 1;
          else if (outcome === 'unchanged') s.counts.unchanged += 1;
          else if (outcome === 'pending') s.counts.pending += 1;
          else if (outcome === 'conflict') s.counts.conflicts += 1;
          else s.counts.rejected += 1;
        }
        if (!part.final) return [];
        // Only a complete, in-order snapshot in which every item was readable may declare anything missing.
        const missing = s.counts.rejected === 0 ? this.broker.markUnseen(s.origin, s.vaultId, s.seen) : 0;
        return [await s.channel.seal('snapshot.result', { ...s.counts, missing })];
      }
      case 'bye':
        return [];
      default:
        throw new VaultBridgeError('Unknown message type', 'PROTOCOL');
    }
  }
}
