import type { PublicJwk } from '@acc/shared';
import type { Db } from '../db/database.js';
import { now } from '../store/store.js';

/** The paired identity and the node's local remote-control permissions (docs/systems/remote-node.md). */
export interface RemoteConfig {
  relayUrl: string;
  nodeId: string;
  label: string;
  enabled: boolean;
  publicKey: PublicJwk;
  sealedKey: { ciphertext: string; iv: string; tag: string };
  keyVersion: number;
  /** Cloud-opened terminals; changeable only from this machine. */
  remoteTerminals: boolean;
  /** Operator tool calls from the cloud; changeable only from this machine. */
  remoteTools: boolean;
  pairedAt: string;
  updatedAt: string;
}

export interface SyncState {
  ackedSeq: number;
  usageCursor: string | null;
  resyncRequired: boolean;
  lastConnectedAt: string | null;
  lastError: string | null;
}

export type ReceiptStatus = 'running' | 'succeeded' | 'failed' | 'rejected' | 'interrupted';

export interface CommandReceipt {
  commandId: string;
  op: string;
  payloadHash: string;
  status: ReceiptStatus;
  httpStatus: number | null;
  result: unknown;
  errorCode: string | null;
  receivedAt: string;
  finishedAt: string | null;
  reportedAt: string | null;
}

export interface OutboxRow {
  seq: number;
  entityKey: string;
  kind: 'message' | 'taskDetail';
  payload: unknown;
}

export type SyncObjectStatus = 'pending' | 'uploaded' | 'failed' | 'local_only';

export interface SyncObject {
  objectKey: string;
  kind: 'artifact' | 'log';
  taskId: string;
  sensitivity: 'safe_sync' | 'local_only' | 'user_shared';
  status: SyncObjectStatus;
  sha256: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
}

/** Hard ceiling on buffered events; beyond it the oldest are dropped and a full resync is scheduled. */
export const OUTBOX_LIMIT = 10_000;

interface ConfigRow {
  relay_url: string;
  node_id: string;
  label: string;
  enabled: number;
  public_key: string;
  private_key_ciphertext: string;
  private_key_iv: string;
  private_key_tag: string;
  key_version: number;
  remote_terminals: number;
  remote_tools: number;
  paired_at: string;
  updated_at: string;
}

/** SQLite persistence for the remote node (migration 6). Every write is one statement or one transaction. */
export class RemoteStore {
  constructor(private readonly db: Db) {}

  // ----- identity and permissions ------------------------------------------------

  config(): RemoteConfig | null {
    const row = this.db.prepare('SELECT * FROM remote_config WHERE id = 1').get() as ConfigRow | undefined;
    if (!row) return null;
    return {
      relayUrl: row.relay_url,
      nodeId: row.node_id,
      label: row.label,
      enabled: row.enabled === 1,
      publicKey: JSON.parse(row.public_key) as PublicJwk,
      sealedKey: { ciphertext: row.private_key_ciphertext, iv: row.private_key_iv, tag: row.private_key_tag },
      keyVersion: row.key_version,
      remoteTerminals: row.remote_terminals === 1,
      remoteTools: row.remote_tools === 1,
      pairedAt: row.paired_at,
      updatedAt: row.updated_at,
    };
  }

  savePairing(input: { relayUrl: string; nodeId: string; label: string; publicKey: PublicJwk; sealedKey: RemoteConfig['sealedKey'] }): void {
    const ts = now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM remote_config').run();
      this.db
        .prepare(
          `INSERT INTO remote_config (id, relay_url, node_id, label, enabled, public_key, private_key_ciphertext, private_key_iv, private_key_tag, key_version, remote_terminals, remote_tools, paired_at, updated_at)
           VALUES (1, ?, ?, ?, 1, ?, ?, ?, ?, 1, 0, 0, ?, ?)`,
        )
        .run(input.relayUrl, input.nodeId, input.label, JSON.stringify(input.publicKey), input.sealedKey.ciphertext, input.sealedKey.iv, input.sealedKey.tag, ts, ts);
      // A new pairing starts a new cloud history: everything is re-sent.
      this.db.prepare('DELETE FROM remote_outbox').run();
      this.db.prepare('DELETE FROM remote_sync_state').run();
      this.db.prepare('INSERT INTO remote_sync_state (id, acked_seq, resync_required, updated_at) VALUES (1, 0, 1, ?)').run(ts);
      this.db.prepare('DELETE FROM remote_artifact_sync').run();
    })();
  }

  rotateKey(publicKey: PublicJwk, sealedKey: RemoteConfig['sealedKey']): void {
    this.db
      .prepare('UPDATE remote_config SET public_key = ?, private_key_ciphertext = ?, private_key_iv = ?, private_key_tag = ?, key_version = key_version + 1, updated_at = ? WHERE id = 1')
      .run(JSON.stringify(publicKey), sealedKey.ciphertext, sealedKey.iv, sealedKey.tag, now());
  }

  updatePermissions(patch: { enabled?: boolean; remoteTerminals?: boolean; remoteTools?: boolean; label?: string }): void {
    const current = this.config();
    if (!current) return;
    this.db
      .prepare('UPDATE remote_config SET enabled = ?, remote_terminals = ?, remote_tools = ?, label = ?, updated_at = ? WHERE id = 1')
      .run(
        (patch.enabled ?? current.enabled) ? 1 : 0,
        (patch.remoteTerminals ?? current.remoteTerminals) ? 1 : 0,
        (patch.remoteTools ?? current.remoteTools) ? 1 : 0,
        patch.label ?? current.label,
        now(),
      );
  }

  /** Forget the pairing. Received-command receipts stay: they are the local audit of what the cloud asked for. */
  clearPairing(): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM remote_config').run();
      this.db.prepare('DELETE FROM remote_outbox').run();
      this.db.prepare('DELETE FROM remote_sync_state').run();
      this.db.prepare('DELETE FROM remote_artifact_sync').run();
    })();
  }

  // ----- sync cursors ---------------------------------------------------------------

  syncState(): SyncState {
    const row = this.db.prepare('SELECT * FROM remote_sync_state WHERE id = 1').get() as
      | { acked_seq: number; usage_cursor: string | null; resync_required: number; last_connected_at: string | null; last_error: string | null }
      | undefined;
    return {
      ackedSeq: row?.acked_seq ?? 0,
      usageCursor: row?.usage_cursor ?? null,
      resyncRequired: (row?.resync_required ?? 1) === 1,
      lastConnectedAt: row?.last_connected_at ?? null,
      lastError: row?.last_error ?? null,
    };
  }

  private patchSync(columns: Record<string, string | number | null>): void {
    const names = Object.keys(columns);
    this.db
      .prepare(`INSERT INTO remote_sync_state (id, updated_at) VALUES (1, ?) ON CONFLICT(id) DO NOTHING`)
      .run(now());
    this.db.prepare(`UPDATE remote_sync_state SET ${names.map((n) => `${n} = ?`).join(', ')}, updated_at = ? WHERE id = 1`).run(...names.map((n) => columns[n]!), now());
  }

  setConnected(at: string): void {
    this.patchSync({ last_connected_at: at, last_error: null });
  }

  setError(message: string | null): void {
    this.patchSync({ last_error: message });
  }

  setResyncRequired(required: boolean): void {
    this.patchSync({ resync_required: required ? 1 : 0 });
  }

  setUsageCursor(cursor: string): void {
    this.patchSync({ usage_cursor: cursor });
  }

  // ----- outbox -----------------------------------------------------------------------

  /**
   * Queue a sanitized event. Events carry complete entities, so a newer event
   * for the same entity replaces the queued one (and moves to the end): the
   * queue is bounded by the number of distinct entities changed while offline.
   */
  enqueue(entityKey: string, kind: OutboxRow['kind'], payload: unknown): number {
    const text = JSON.stringify(payload);
    let seq = 0;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM remote_outbox WHERE entity_key = ?').run(entityKey);
      seq = Number(this.db.prepare('INSERT INTO remote_outbox (entity_key, kind, payload, created_at) VALUES (?, ?, ?, ?)').run(entityKey, kind, text, now()).lastInsertRowid);
      const depth = (this.db.prepare('SELECT COUNT(*) AS n FROM remote_outbox').get() as { n: number }).n;
      if (depth > OUTBOX_LIMIT) {
        this.db.prepare('DELETE FROM remote_outbox WHERE seq IN (SELECT seq FROM remote_outbox ORDER BY seq LIMIT ?)').run(depth - OUTBOX_LIMIT);
        this.patchSync({ resync_required: 1 });
      }
    })();
    return seq;
  }

  pending(afterSeq: number, limit: number): OutboxRow[] {
    return (this.db.prepare('SELECT seq, entity_key, kind, payload FROM remote_outbox WHERE seq > ? ORDER BY seq LIMIT ?').all(afterSeq, limit) as Array<{ seq: number; entity_key: string; kind: OutboxRow['kind']; payload: string }>).map((r) => ({
      seq: r.seq,
      entityKey: r.entity_key,
      kind: r.kind,
      payload: JSON.parse(r.payload) as unknown,
    }));
  }

  /** The cloud stored everything up to `seq`: drop it and move the cursor. */
  acknowledge(seq: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM remote_outbox WHERE seq <= ?').run(seq);
      this.patchSync({ acked_seq: seq });
    })();
  }

  outboxDepth(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM remote_outbox').get() as { n: number }).n;
  }

  /** Highest sequence ever issued (survives an emptied queue). */
  lastIssuedSeq(): number {
    const row = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'remote_outbox'").get() as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  /** After a database restore the local sequence may be behind the cloud's cursor; move it past, or new events would look like duplicates. */
  ensureSequenceAtLeast(seq: number): void {
    if (this.lastIssuedSeq() >= seq) return;
    this.db.transaction(() => {
      const updated = this.db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'remote_outbox'").run(seq);
      if (updated.changes === 0) this.db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('remote_outbox', ?)").run(seq);
    })();
  }

  // ----- command receipts ----------------------------------------------------------------

  receipt(commandId: string): CommandReceipt | null {
    const row = this.db.prepare('SELECT * FROM remote_commands_received WHERE command_id = ?').get(commandId) as ReceiptRow | undefined;
    return row ? toReceipt(row) : null;
  }

  /**
   * Record that a command arrived, before anything runs. Returns false when
   * the id was already recorded — the caller must not execute it again.
   */
  recordReceipt(commandId: string, op: string, payloadHash: string): boolean {
    const result = this.db
      .prepare("INSERT OR IGNORE INTO remote_commands_received (command_id, op, payload_hash, status, received_at) VALUES (?, ?, ?, 'running', ?)")
      .run(commandId, op, payloadHash, now());
    return result.changes === 1;
  }

  finishReceipt(commandId: string, status: Exclude<ReceiptStatus, 'running'>, outcome: { httpStatus: number | null; result: unknown; errorCode: string | null }): void {
    this.db
      .prepare('UPDATE remote_commands_received SET status = ?, http_status = ?, result = ?, error_code = ?, finished_at = ? WHERE command_id = ?')
      .run(status, outcome.httpStatus, JSON.stringify(outcome.result ?? null), outcome.errorCode, now(), commandId);
  }

  markReported(commandId: string): void {
    this.db.prepare('UPDATE remote_commands_received SET reported_at = ? WHERE command_id = ? AND reported_at IS NULL').run(now(), commandId);
  }

  /** Finished results the cloud has not acknowledged yet (lost on the way): replayed after reconnect. */
  unreported(limit = 100): CommandReceipt[] {
    return (this.db.prepare("SELECT * FROM remote_commands_received WHERE status != 'running' AND reported_at IS NULL ORDER BY received_at LIMIT ?").all(limit) as ReceiptRow[]).map(toReceipt);
  }

  /** A restart interrupted these mid-run. They are never re-run: the outcome is unknown, so they are reported as interrupted. */
  interruptRunning(): number {
    return this.db
      .prepare("UPDATE remote_commands_received SET status = 'interrupted', error_code = 'REMOTE_INTERRUPTED', finished_at = ? WHERE status = 'running'")
      .run(now()).changes;
  }

  // ----- artifacts and log chunks ------------------------------------------------------------

  syncObject(objectKey: string): SyncObject | null {
    const row = this.db.prepare('SELECT * FROM remote_artifact_sync WHERE object_key = ?').get(objectKey) as SyncObjectRow | undefined;
    return row ? toSyncObject(row) : null;
  }

  upsertSyncObject(o: Pick<SyncObject, 'objectKey' | 'kind' | 'taskId' | 'sensitivity' | 'status'>): void {
    this.db
      .prepare(
        `INSERT INTO remote_artifact_sync (object_key, kind, task_id, sensitivity, status, attempts, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(object_key) DO UPDATE SET sensitivity = excluded.sensitivity, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(o.objectKey, o.kind, o.taskId, o.sensitivity, o.status, now());
  }

  markObject(objectKey: string, patch: { status: SyncObjectStatus; sha256?: string | null; error?: string | null; nextAttemptAt?: string | null; attempted?: boolean }): void {
    this.db
      .prepare(
        'UPDATE remote_artifact_sync SET status = ?, sha256 = COALESCE(?, sha256), last_error = ?, next_attempt_at = ?, attempts = attempts + ?, updated_at = ? WHERE object_key = ?',
      )
      .run(patch.status, patch.sha256 ?? null, patch.error ?? null, patch.nextAttemptAt ?? null, patch.attempted ? 1 : 0, now(), objectKey);
  }

  dueObjects(at: string, limit = 20): SyncObject[] {
    return (
      this.db
        .prepare("SELECT * FROM remote_artifact_sync WHERE status IN ('pending', 'failed') AND attempts < 8 AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY updated_at LIMIT ?")
        .all(at, limit) as SyncObjectRow[]
    ).map(toSyncObject);
  }
}

interface ReceiptRow {
  command_id: string;
  op: string;
  payload_hash: string;
  status: ReceiptStatus;
  http_status: number | null;
  result: string | null;
  error_code: string | null;
  received_at: string;
  finished_at: string | null;
  reported_at: string | null;
}

function toReceipt(r: ReceiptRow): CommandReceipt {
  return {
    commandId: r.command_id,
    op: r.op,
    payloadHash: r.payload_hash,
    status: r.status,
    httpStatus: r.http_status,
    result: r.result ? (JSON.parse(r.result) as unknown) : null,
    errorCode: r.error_code,
    receivedAt: r.received_at,
    finishedAt: r.finished_at,
    reportedAt: r.reported_at,
  };
}

interface SyncObjectRow {
  object_key: string;
  kind: SyncObject['kind'];
  task_id: string;
  sensitivity: SyncObject['sensitivity'];
  status: SyncObjectStatus;
  sha256: string | null;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
}

function toSyncObject(r: SyncObjectRow): SyncObject {
  return {
    objectKey: r.object_key,
    kind: r.kind,
    taskId: r.task_id,
    sensitivity: r.sensitivity,
    status: r.status,
    sha256: r.sha256,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
  };
}
