import {
  canTransition,
  COMMAND_STATUSES,
  REMOTE_MIN_PROTOCOL_VERSION,
  TERMINAL_TASK_STATUSES,
  type CloudCommandView,
  type CloudNodeView,
  type CloudPairingToken,
  type CommandStatus,
  type NodeCapabilities,
  type NodeRepository,
  type NodeStatus,
  type OutboxEvent,
  type PublicJwk,
  type RemoteCommand,
} from '@acc/shared';
import type { CommandWait } from './hub.js';
import { nowIso } from './http.js';

/**
 * D1 persistence for the control plane (docs/systems/cloud-control.md §Data).
 * Idempotency lives in constraints: `(created_by, idempotency_key)` for
 * commands, `(node_id, event_id)` for events and usage, `nodes.last_event_seq`
 * for batches, single-use updates for pairing codes and nonces.
 */

/** A node counts as degraded after this long without a heartbeat, offline after the second. */
export const DEGRADED_AFTER_MS = 2 * 60_000;
export const OFFLINE_AFTER_MS = 5 * 60_000;
/** Largest result body kept for a command (the browser refetches anything bigger). */
const RESULT_BODY_CHARS = 256 * 1024;
/** Lease safety net: a remote task that never reports an end frees its repository after this. */
export const LEASE_TTL_MS = 24 * 60 * 60_000;

interface NodeRow {
  id: string;
  label: string;
  os: string | null;
  app_version: string | null;
  protocol_version: number | null;
  public_key: string;
  key_version: number;
  status: string;
  capabilities: string | null;
  last_event_seq: number;
  created_at: string;
  paired_by: string;
  last_seen_at: string | null;
  connected_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

export interface NodeRecord {
  id: string;
  label: string;
  publicKey: PublicJwk;
  keyVersion: number;
  protocolVersion: number | null;
  status: string;
  lastEventSeq: number;
  revokedAt: string | null;
}

function toRecord(r: NodeRow): NodeRecord {
  return { id: r.id, label: r.label, publicKey: JSON.parse(r.public_key) as PublicJwk, keyVersion: r.key_version, protocolVersion: r.protocol_version, status: r.status, lastEventSeq: r.last_event_seq, revokedAt: r.revoked_at };
}

export function nodeStatus(r: Pick<NodeRow, 'status' | 'last_seen_at' | 'revoked_at'>, now = Date.now()): NodeStatus {
  if (r.revoked_at) return 'revoked';
  if (r.status !== 'online') return 'offline';
  const age = r.last_seen_at ? now - Date.parse(r.last_seen_at) : Number.POSITIVE_INFINITY;
  if (age > OFFLINE_AFTER_MS) return 'offline';
  if (age > DEGRADED_AFTER_MS) return 'degraded';
  return 'online';
}

export class CloudStore {
  constructor(private readonly db: D1Database) {}

  // ----- nodes ------------------------------------------------------------------

  async node(id: string): Promise<NodeRecord | null> {
    const row = await this.db.prepare('SELECT * FROM nodes WHERE id = ?').bind(id).first<NodeRow>();
    return row ? toRecord(row) : null;
  }

  async nodeView(id: string): Promise<CloudNodeView | null> {
    const row = await this.db.prepare('SELECT * FROM nodes WHERE id = ?').bind(id).first<NodeRow>();
    if (!row) return null;
    const repos = await this.db.prepare('SELECT * FROM node_repositories WHERE node_id = ? ORDER BY name').bind(id).all<RepoRow>();
    return toView(row, repos.results.map(toRepo));
  }

  async listNodes(): Promise<CloudNodeView[]> {
    const rows = await this.db.prepare('SELECT * FROM nodes ORDER BY revoked_at IS NOT NULL, created_at').all<NodeRow>();
    const repos = await this.db.prepare('SELECT * FROM node_repositories ORDER BY name').all<RepoRow>();
    return rows.results.map((r) => toView(r, repos.results.filter((x) => x.node_id === r.id).map(toRepo)));
  }

  async createNode(input: { id: string; label: string; os: string; appVersion: string; protocolVersion: number; publicKey: PublicJwk; pairedBy: string }): Promise<void> {
    await this.db
      .prepare('INSERT INTO nodes (id, label, os, app_version, protocol_version, public_key, key_version, status, created_at, paired_by) VALUES (?, ?, ?, ?, ?, ?, 1, \'offline\', ?, ?)')
      .bind(input.id, input.label, input.os, input.appVersion, input.protocolVersion, JSON.stringify(input.publicKey), nowIso(), input.pairedBy)
      .run();
  }

  async renameNode(id: string, label: string): Promise<void> {
    await this.db.prepare('UPDATE nodes SET label = ? WHERE id = ?').bind(label, id).run();
  }

  async revokeNode(id: string, by: string): Promise<boolean> {
    const r = await this.db.prepare("UPDATE nodes SET revoked_at = ?, revoked_by = ?, status = 'offline' WHERE id = ? AND revoked_at IS NULL").bind(nowIso(), by, id).run();
    if (r.meta.changes) {
      // Nothing waits for a revoked node: its pending commands end now, its leases free.
      await this.db.batch([
        this.db.prepare("UPDATE remote_commands SET status = 'rejected', error_code = 'NODE_REVOKED', error_message = 'The node was revoked', finished_at = ? WHERE node_id = ? AND status IN ('pending','delivered')").bind(nowIso(), id),
        this.db.prepare('UPDATE repository_leases SET released_at = ? WHERE node_id = ? AND released_at IS NULL').bind(nowIso(), id),
      ]);
    }
    return r.meta.changes > 0;
  }

  async rotateKey(id: string, publicKey: PublicJwk): Promise<number> {
    await this.db.prepare('UPDATE nodes SET public_key = ?, key_version = key_version + 1 WHERE id = ? AND revoked_at IS NULL').bind(JSON.stringify(publicKey), id).run();
    const row = await this.db.prepare('SELECT key_version FROM nodes WHERE id = ?').bind(id).first<{ key_version: number }>();
    return row?.key_version ?? 0;
  }

  async markConnected(id: string, info: { os: string; appVersion: string; protocolVersion: number; label?: string }): Promise<void> {
    const ts = nowIso();
    await this.db
      .prepare("UPDATE nodes SET status = 'online', os = ?, app_version = ?, protocol_version = ?, connected_at = ?, last_seen_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(info.os, info.appVersion, info.protocolVersion, ts, ts, id)
      .run();
  }

  async markDisconnected(id: string): Promise<void> {
    await this.db.prepare("UPDATE nodes SET status = 'offline', last_seen_at = ? WHERE id = ?").bind(nowIso(), id).run();
  }

  /** Record a heartbeat; false when the node was revoked meanwhile (e.g. by the emergency CLI). */
  async touch(id: string): Promise<boolean> {
    const r = await this.db.prepare('UPDATE nodes SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL').bind(nowIso(), id).run();
    return r.meta.changes > 0;
  }

  async setCapabilities(id: string, capabilities: NodeCapabilities): Promise<void> {
    await this.db.prepare('UPDATE nodes SET capabilities = ? WHERE id = ?').bind(JSON.stringify(capabilities), id).run();
  }

  async setRepositories(id: string, repositories: NodeRepository[]): Promise<void> {
    const ts = nowIso();
    await this.db.batch([
      this.db.prepare('DELETE FROM node_repositories WHERE node_id = ?').bind(id),
      ...repositories.map((r) =>
        this.db
          .prepare('INSERT INTO node_repositories (node_id, local_id, name, fingerprint, remote_host, default_branch, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(id, r.localId, r.name, r.fingerprint, r.remoteHost, r.defaultBranch, ts),
      ),
    ]);
  }

  async repositoryFingerprint(nodeId: string, repositoryId: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT fingerprint FROM node_repositories WHERE node_id = ? AND local_id = ?').bind(nodeId, repositoryId).first<{ fingerprint: string }>();
    return row?.fingerprint ?? null;
  }

  // ----- pairing and challenges -------------------------------------------------------

  async createPairingToken(input: { id: string; tokenHash: string; label: string; createdBy: string; expiresAt: string }): Promise<void> {
    await this.db
      .prepare('INSERT INTO pairing_tokens (id, token_hash, label, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(input.id, input.tokenHash, input.label, input.createdBy, nowIso(), input.expiresAt)
      .run();
  }

  async listPairingTokens(): Promise<CloudPairingToken[]> {
    const rows = await this.db.prepare('SELECT id, label, created_by, created_at, expires_at, used_at, revoked_at FROM pairing_tokens ORDER BY created_at DESC LIMIT 50').all<Record<string, string | null>>();
    return rows.results.map((r) => ({ id: r.id!, label: r.label!, createdBy: r.created_by!, createdAt: r.created_at!, expiresAt: r.expires_at!, usedAt: r.used_at ?? null, revokedAt: r.revoked_at ?? null }));
  }

  async revokePairingToken(id: string): Promise<boolean> {
    const r = await this.db.prepare('UPDATE pairing_tokens SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').bind(nowIso(), id).run();
    return r.meta.changes > 0;
  }

  /** Spend a pairing code: succeeds exactly once, only while unexpired and not revoked. */
  async consumePairingToken(tokenHash: string, nodeId: string): Promise<{ label: string; createdBy: string } | null> {
    const ts = nowIso();
    const r = await this.db
      .prepare('UPDATE pairing_tokens SET used_at = ?, used_by_node = ? WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
      .bind(ts, nodeId, tokenHash, ts)
      .run();
    if (!r.meta.changes) return null;
    const row = await this.db.prepare('SELECT label, created_by FROM pairing_tokens WHERE token_hash = ?').bind(tokenHash).first<{ label: string; created_by: string }>();
    return row ? { label: row.label, createdBy: row.created_by } : null;
  }

  async createChallenge(nonceHash: string, nodeId: string, expiresAt: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM node_challenges WHERE expires_at < ?').bind(nowIso()),
      this.db.prepare('INSERT INTO node_challenges (nonce_hash, node_id, expires_at) VALUES (?, ?, ?)').bind(nonceHash, nodeId, expiresAt),
    ]);
  }

  /** Spend a nonce: once, for its node, before it expires. A replay gets false. */
  async consumeChallenge(nonceHash: string, nodeId: string): Promise<boolean> {
    const ts = nowIso();
    const r = await this.db.prepare('UPDATE node_challenges SET used_at = ? WHERE nonce_hash = ? AND node_id = ? AND used_at IS NULL AND expires_at > ?').bind(ts, nonceHash, nodeId, ts).run();
    return r.meta.changes > 0;
  }

  // ----- commands ---------------------------------------------------------------------------

  /** Insert a command, or return the existing one for the same (creator, idempotency key). */
  async insertCommand(c: RemoteCommand & { taskId: string | null; leaseFingerprint: string | null }): Promise<{ created: boolean; command: CommandRow }> {
    const r = await this.db
      .prepare(
        `INSERT INTO remote_commands (id, node_id, op, params, query, body, idempotency_key, payload_hash, precondition, status, created_by, created_at, expires_at, task_id, lease_fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
         ON CONFLICT (created_by, idempotency_key) DO NOTHING`,
      )
      .bind(c.id, c.nodeId, c.op, JSON.stringify(c.params), JSON.stringify(c.query), c.body === undefined ? null : JSON.stringify(c.body), c.idempotencyKey, c.payloadHash, c.precondition ? JSON.stringify(c.precondition) : null, c.createdBy, c.createdAt, c.expiresAt, c.taskId, c.leaseFingerprint)
      .run();
    const row = await this.db.prepare('SELECT * FROM remote_commands WHERE created_by = ? AND idempotency_key = ?').bind(c.createdBy, c.idempotencyKey).first<CommandRow>();
    return { created: r.meta.changes > 0, command: row! };
  }

  async commandByKey(createdBy: string, idempotencyKey: string): Promise<CommandRow | null> {
    return this.db.prepare('SELECT * FROM remote_commands WHERE created_by = ? AND idempotency_key = ?').bind(createdBy, idempotencyKey).first<CommandRow>();
  }

  async command(id: string): Promise<CommandRow | null> {
    return this.db.prepare('SELECT * FROM remote_commands WHERE id = ?').bind(id).first<CommandRow>();
  }

  async listCommands(filter: { nodeId?: string; limit: number }): Promise<CloudCommandView[]> {
    const rows = filter.nodeId
      ? await this.db.prepare('SELECT * FROM remote_commands WHERE node_id = ? ORDER BY created_at DESC LIMIT ?').bind(filter.nodeId, filter.limit).all<CommandRow>()
      : await this.db.prepare('SELECT * FROM remote_commands ORDER BY created_at DESC LIMIT ?').bind(filter.limit).all<CommandRow>();
    return rows.results.map(commandView);
  }

  /** Commands to (re)send to a node after it connects: undelivered, or claimed without a stored result. */
  async deliverable(nodeId: string): Promise<CommandRow[]> {
    const ts = nowIso();
    await this.db.prepare("UPDATE remote_commands SET status = 'expired', finished_at = ?, error_code = 'REMOTE_COMMAND_EXPIRED' WHERE node_id = ? AND status IN ('pending','delivered') AND expires_at <= ?").bind(ts, nodeId, ts).run();
    const rows = await this.db.prepare("SELECT * FROM remote_commands WHERE node_id = ? AND status IN ('pending','delivered','claimed') ORDER BY created_at LIMIT 200").bind(nodeId).all<CommandRow>();
    return rows.results;
  }

  /**
   * Move a command forward. Transitions follow COMMAND_TRANSITIONS; a final
   * state never changes again, so a replayed result is a no-op.
   */
  async transition(id: string, nodeId: string, to: CommandStatus, fields: { resultStatus?: number | null; resultBody?: unknown; errorCode?: string | null; errorMessage?: string | null } = {}): Promise<CommandRow | null> {
    // One conditional statement: the move happens only from a state that allows it,
    // so two frames racing for the same command cannot overwrite each other.
    const from = COMMAND_STATUSES.filter((s) => canTransition(s, to));
    const ts = nowIso();
    const column = to === 'delivered' ? 'delivered_at' : to === 'claimed' ? 'claimed_at' : 'finished_at';
    let body: string | null = null;
    if (fields.resultBody !== undefined) {
      body = JSON.stringify(fields.resultBody ?? null);
      if (body.length > RESULT_BODY_CHARS) body = JSON.stringify({ note: 'The result was too large to keep; the view refreshes from the node.' });
    }
    if (from.length) {
      await this.db
        .prepare(`UPDATE remote_commands SET status = ?, ${column} = ?, result_status = COALESCE(?, result_status), result_body = COALESCE(?, result_body), error_code = COALESCE(?, error_code), error_message = COALESCE(?, error_message) WHERE id = ? AND node_id = ? AND status IN (${from.map(() => '?').join(',')})`)
        .bind(to, ts, fields.resultStatus ?? null, body, fields.errorCode ?? null, fields.errorMessage ?? null, id, nodeId, ...from)
        .run();
    }
    return this.db.prepare('SELECT * FROM remote_commands WHERE id = ? AND node_id = ?').bind(id, nodeId).first<CommandRow>();
  }

  async setCommandTask(id: string, taskId: string): Promise<void> {
    await this.db.prepare('UPDATE remote_commands SET task_id = ? WHERE id = ?').bind(taskId, id).run();
  }

  // ----- repository leases ---------------------------------------------------------------------

  /**
   * Take the cloud lease on a repository fingerprint for a remotely started
   * mutating task. Another node holding an active lease wins; the same node
   * may start more work (its own RepositoryCoordinator serializes locally).
   */
  async acquireLease(fingerprint: string, nodeId: string, commandId: string, holder: string): Promise<{ ok: true } | { ok: false; heldBy: string; taskId: string | null }> {
    const ts = nowIso();
    const expires = new Date(Date.now() + LEASE_TTL_MS).toISOString();
    await this.db
      .prepare(
        `INSERT INTO repository_leases (fingerprint, node_id, command_id, task_id, holder, acquired_at, expires_at, released_at) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)
         ON CONFLICT (fingerprint) DO UPDATE SET node_id = excluded.node_id, command_id = excluded.command_id, task_id = CASE WHEN repository_leases.node_id = excluded.node_id AND repository_leases.released_at IS NULL THEN repository_leases.task_id ELSE NULL END,
           holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at, released_at = NULL
         WHERE repository_leases.released_at IS NOT NULL OR repository_leases.expires_at <= ? OR repository_leases.node_id = excluded.node_id`,
      )
      .bind(fingerprint, nodeId, commandId, holder, ts, expires, ts)
      .run();
    const row = await this.db.prepare('SELECT node_id, task_id, command_id FROM repository_leases WHERE fingerprint = ?').bind(fingerprint).first<{ node_id: string; task_id: string | null; command_id: string | null }>();
    if (row && row.node_id === nodeId && row.command_id === commandId) return { ok: true };
    return { ok: false, heldBy: row?.node_id ?? 'unknown', taskId: row?.task_id ?? null };
  }

  /**
   * Release this node's leases on repositories where it has nothing left in flight: no
   * undelivered or running command, and no task a command started that is still unfinished
   * (or not mirrored yet). Judged from state rather than one remembered task, so a second task
   * on the same repository keeps the lease until both are done. A lease whose latest command
   * row is not written yet (it is written right after the lease) is kept too.
   */
  releaseIdleLeasesStatement(nodeId: string): D1PreparedStatement {
    const now = Date.now();
    return this.db
      .prepare(
        `UPDATE repository_leases SET released_at = ?
         WHERE node_id = ? AND released_at IS NULL
           AND EXISTS (SELECT 1 FROM remote_commands k WHERE k.id = repository_leases.command_id)
           AND NOT EXISTS (
             SELECT 1 FROM remote_commands c
             WHERE c.node_id = repository_leases.node_id AND c.lease_fingerprint = repository_leases.fingerprint
               AND (c.status IN ('pending', 'delivered', 'claimed')
                 OR (c.status = 'succeeded' AND c.task_id IS NOT NULL AND c.finished_at > ?
                   AND NOT EXISTS (SELECT 1 FROM cloud_tasks t WHERE t.node_id = c.node_id AND t.task_id = c.task_id AND t.status IN ('COMPLETED', 'CANCELLED', 'FAILED')))))`,
      )
      .bind(new Date(now).toISOString(), nodeId, new Date(now - LEASE_TTL_MS).toISOString());
  }

  /** The lease was taken for a command that turned out to be a repeat: point it at the command that exists. */
  async repointLease(fingerprint: string, fromCommandId: string, toCommandId: string): Promise<void> {
    await this.db.prepare('UPDATE repository_leases SET command_id = ? WHERE fingerprint = ? AND command_id = ?').bind(toCommandId, fingerprint, fromCommandId).run();
  }

  async releaseIdleLeases(nodeId: string): Promise<void> {
    await this.releaseIdleLeasesStatement(nodeId).run();
  }

  // ----- mirrored history ------------------------------------------------------------------------

  async lastEventSeq(nodeId: string): Promise<number> {
    const row = await this.db.prepare('SELECT last_event_seq FROM nodes WHERE id = ?').bind(nodeId).first<{ last_event_seq: number }>();
    return row?.last_event_seq ?? 0;
  }

  /**
   * Store one batch atomically: events at or below the node's cursor are
   * duplicates and skipped; the cursor moves to the batch's last sequence.
   * Returns the events that were new, for browser fan-out.
   */
  async ingest(nodeId: string, events: OutboxEvent[]): Promise<{ fresh: OutboxEvent[]; ackedSeq: number }> {
    const cursor = await this.lastEventSeq(nodeId);
    const fresh = events.filter((e) => e.seq > cursor).sort((a, b) => a.seq - b.seq);
    const last = Math.max(cursor, ...events.map((e) => e.seq));
    const statements: D1PreparedStatement[] = [];
    const ts = nowIso();
    for (const e of fresh) statements.push(...this.eventStatements(nodeId, e, ts));
    statements.push(this.db.prepare('UPDATE nodes SET last_event_seq = ?, last_seen_at = ? WHERE id = ? AND last_event_seq < ?').bind(last, ts, nodeId, last));
    await this.db.batch(statements);
    return { fresh, ackedSeq: last };
  }

  private eventStatements(nodeId: string, e: OutboxEvent, ts: string): D1PreparedStatement[] {
    const p = e.payload as Record<string, any> | null;
    if (!p || typeof p !== 'object') return [];
    if (e.kind === 'taskDetail') {
      if (typeof p.taskId !== 'string') return [];
      return [this.db.prepare('UPDATE cloud_tasks SET detail = ?, detail_updated_at = ? WHERE node_id = ? AND task_id = ?').bind(JSON.stringify(p.detail ?? null), ts, nodeId, p.taskId)];
    }
    const entity = (kind: string, id: string, json: unknown, taskId: string | null = null) =>
      this.db
        .prepare('INSERT INTO cloud_entities (node_id, kind, entity_id, task_id, updated_at, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (node_id, kind, entity_id) DO UPDATE SET json = excluded.json, task_id = excluded.task_id, updated_at = excluded.updated_at')
        .bind(nodeId, kind, id, taskId, ts, JSON.stringify(json));
    switch (p.type) {
      case 'task': {
        const t = p.task as Record<string, any>;
        const out = [
          this.db
            .prepare(
              `INSERT INTO cloud_tasks (node_id, task_id, repository_id, repository_name, title, status, version, created_at, updated_at, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (node_id, task_id) DO UPDATE SET repository_id = excluded.repository_id, repository_name = excluded.repository_name, title = excluded.title, status = excluded.status, version = excluded.version, updated_at = excluded.updated_at, summary = excluded.summary`,
            )
            .bind(nodeId, String(t.id), t.repositoryId ?? null, t.repositoryName ?? null, String(t.title ?? ''), String(t.status), Number(t.version ?? 0), String(t.createdAt ?? ts), String(t.updatedAt ?? ts), JSON.stringify(t)),
        ];
        if ((TERMINAL_TASK_STATUSES as readonly string[]).includes(String(t.status)) || t.status === 'FAILED') out.push(this.releaseIdleLeasesStatement(nodeId));
        return out;
      }
      case 'task.deleted':
        return [
          this.db.prepare('DELETE FROM cloud_tasks WHERE node_id = ? AND task_id = ?').bind(nodeId, String(p.taskId)),
          this.db.prepare('DELETE FROM cloud_task_events WHERE node_id = ? AND task_id = ?').bind(nodeId, String(p.taskId)),
        ];
      case 'event': {
        const ev = p.event as Record<string, any>;
        return [this.db.prepare('INSERT OR IGNORE INTO cloud_task_events (node_id, event_id, task_id, type, at, json) VALUES (?, ?, ?, ?, ?, ?)').bind(nodeId, Number(ev.id), String(ev.taskId), String(ev.type), String(ev.at), JSON.stringify(ev))];
      }
      case 'approval':
        return [entity('approval', String(p.approval.id), p.approval, String(p.approval.taskId))];
      case 'artifact':
        return [entity('artifact', String(p.artifact.id), p.artifact, String(p.artifact.taskId))];
      case 'repository':
        return [entity('repository', String(p.repository.id), p.repository)];
      case 'repository.deleted':
        return [this.db.prepare("DELETE FROM cloud_entities WHERE node_id = ? AND kind = 'repository' AND entity_id = ?").bind(nodeId, String(p.repositoryId))];
      case 'agents':
        return [entity('agents', 'all', p.agents)];
      case 'usage': {
        const u = p.event as Record<string, any>;
        return [
          this.db
            .prepare('INSERT INTO cloud_usage_events (node_id, event_id, task_id, provider, model, started_at, display_cost_nanos, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (node_id, event_id) DO UPDATE SET display_cost_nanos = excluded.display_cost_nanos, json = excluded.json')
            .bind(nodeId, String(u.id), u.taskId ?? null, u.provider ?? null, u.model ?? null, String(u.startedAt), u.displayCostNanos ?? null, JSON.stringify(u)),
        ];
      }
      default:
        return [];
    }
  }

  async entity<T>(nodeId: string, kind: string, id: string): Promise<T | null> {
    const row = await this.db.prepare('SELECT json FROM cloud_entities WHERE node_id = ? AND kind = ? AND entity_id = ?').bind(nodeId, kind, id).first<{ json: string }>();
    return row ? (JSON.parse(row.json) as T) : null;
  }

  async entities<T>(nodeId: string, kind: string, taskId?: string): Promise<T[]> {
    const rows = taskId
      ? await this.db.prepare('SELECT json FROM cloud_entities WHERE node_id = ? AND kind = ? AND task_id = ? ORDER BY updated_at DESC LIMIT 500').bind(nodeId, kind, taskId).all<{ json: string }>()
      : await this.db.prepare('SELECT json FROM cloud_entities WHERE node_id = ? AND kind = ? ORDER BY updated_at DESC LIMIT 500').bind(nodeId, kind).all<{ json: string }>();
    return rows.results.map((r) => JSON.parse(r.json) as T);
  }

  async taskVersion(nodeId: string, taskId: string): Promise<{ version: number; repositoryId: string | null } | null> {
    const row = await this.db.prepare('SELECT version, repository_id FROM cloud_tasks WHERE node_id = ? AND task_id = ?').bind(nodeId, taskId).first<{ version: number; repository_id: string | null }>();
    return row ? { version: row.version, repositoryId: row.repository_id } : null;
  }

  // ----- artifacts and log chunks -------------------------------------------------------------------

  async upsertManifest(nodeId: string, m: { artifactId: string; taskId: string; name: string; mime: string; size: number; sha256: string | null; sensitivity: string; status: string; error: string | null; r2Key?: string | null }): Promise<void> {
    const ts = nowIso();
    await this.db
      .prepare(
        `INSERT INTO artifact_manifests (node_id, artifact_id, task_id, name, mime, size, sha256, sensitivity, status, r2_key, error, created_at, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (node_id, artifact_id) DO UPDATE SET status = CASE WHEN excluded.sensitivity = 'local_only' THEN 'local_only' WHEN artifact_manifests.status = 'uploaded' AND excluded.status != 'uploaded' THEN artifact_manifests.status ELSE excluded.status END,
           sha256 = CASE WHEN excluded.sensitivity = 'local_only' THEN NULL ELSE COALESCE(excluded.sha256, artifact_manifests.sha256) END,
           r2_key = CASE WHEN excluded.sensitivity = 'local_only' THEN NULL ELSE COALESCE(excluded.r2_key, artifact_manifests.r2_key) END, error = excluded.error, sensitivity = excluded.sensitivity,
           uploaded_at = COALESCE(excluded.uploaded_at, artifact_manifests.uploaded_at)`,
      )
      .bind(nodeId, m.artifactId, m.taskId, m.name, m.mime, m.size, m.sha256, m.sensitivity, m.status, m.r2Key ?? null, m.error, ts, m.status === 'uploaded' ? ts : null)
      .run();
  }

  async manifest(nodeId: string, artifactId: string): Promise<{ task_id: string; name: string; mime: string; size: number; sha256: string | null; status: string; r2_key: string | null; sensitivity: string } | null> {
    return this.db.prepare('SELECT task_id, name, mime, size, sha256, status, r2_key, sensitivity FROM artifact_manifests WHERE node_id = ? AND artifact_id = ?').bind(nodeId, artifactId).first();
  }

  async manifestsForTask(nodeId: string, taskId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.prepare('SELECT artifact_id, name, mime, size, sha256, sensitivity, status, error, uploaded_at FROM artifact_manifests WHERE node_id = ? AND task_id = ? ORDER BY created_at').bind(nodeId, taskId).all();
    return rows.results;
  }

  async logChunkKey(nodeId: string, executionId: string, chunkIndex: number): Promise<string | null> {
    const row = await this.db.prepare('SELECT r2_key FROM log_chunks WHERE node_id = ? AND execution_id = ? AND chunk_index = ?').bind(nodeId, executionId, chunkIndex).first<{ r2_key: string }>();
    return row?.r2_key ?? null;
  }

  async addLogChunk(nodeId: string, c: { executionId: string; taskId: string; chunkIndex: number; firstSeq: number; lastSeq: number; sha256: string; size: number; r2Key: string }): Promise<void> {
    await this.db
      .prepare('INSERT OR REPLACE INTO log_chunks (node_id, execution_id, chunk_index, task_id, first_seq, last_seq, sha256, size, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(nodeId, c.executionId, c.chunkIndex, c.taskId, c.firstSeq, c.lastSeq, c.sha256, c.size, c.r2Key, nowIso())
      .run();
  }

  async logChunks(nodeId: string, executionId: string): Promise<Array<{ chunk_index: number; first_seq: number; last_seq: number; sha256: string; size: number; r2_key: string }>> {
    const rows = await this.db.prepare('SELECT chunk_index, first_seq, last_seq, sha256, size, r2_key FROM log_chunks WHERE node_id = ? AND execution_id = ? ORDER BY chunk_index').bind(nodeId, executionId).all<{ chunk_index: number; first_seq: number; last_seq: number; sha256: string; size: number; r2_key: string }>();
    return rows.results;
  }

  // ----- audit ------------------------------------------------------------------------------------------

  async audit(e: { actor: string; action: string; nodeId?: string | null; target?: string | null; result: string; detail?: Record<string, unknown>; requestId?: string }): Promise<void> {
    await this.db
      .prepare('INSERT INTO audit_events (at, actor, action, node_id, target, result, detail, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(nowIso(), e.actor, e.action, e.nodeId ?? null, e.target ?? null, e.result, e.detail ? JSON.stringify(e.detail) : null, e.requestId ?? null)
      .run();
  }

  async listAudit(limit: number): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.prepare('SELECT * FROM audit_events ORDER BY id DESC LIMIT ?').bind(limit).all();
    return rows.results.map((r) => ({ ...r, detail: r.detail ? JSON.parse(String(r.detail)) : null }));
  }

  // ----- retention -----------------------------------------------------------------------------------------

  /** Daily pruning of cloud copies; the node keeps its own history regardless. */
  async prune(): Promise<{ r2Keys: string[] }> {
    const day = 86_400_000;
    const cut = (days: number) => new Date(Date.now() - days * day).toISOString();
    const oldObjects = await this.db.prepare("SELECT r2_key FROM artifact_manifests WHERE r2_key IS NOT NULL AND created_at < ? UNION ALL SELECT r2_key FROM log_chunks WHERE created_at < ?").bind(cut(90), cut(90)).all<{ r2_key: string }>();
    // A node revoked 30 days ago takes its cloud copies with it: mirror, events, usage, files (audit F-28).
    const gone = "(SELECT id FROM nodes WHERE revoked_at IS NOT NULL AND revoked_at < ?)";
    const goneObjects = await this.db.prepare(`SELECT r2_key FROM artifact_manifests WHERE r2_key IS NOT NULL AND node_id IN ${gone} UNION ALL SELECT r2_key FROM log_chunks WHERE node_id IN ${gone}`).bind(cut(30), cut(30)).all<{ r2_key: string }>();
    await this.db.batch(['cloud_tasks', 'cloud_task_events', 'cloud_entities', 'cloud_usage_events', 'artifact_manifests', 'log_chunks', 'node_repositories'].map((table) => this.db.prepare(`DELETE FROM ${table} WHERE node_id IN ${gone}`).bind(cut(30))));
    await this.db.batch([
      this.db.prepare('DELETE FROM cloud_task_events WHERE at < ?').bind(cut(90)),
      this.db.prepare("DELETE FROM remote_commands WHERE finished_at IS NOT NULL AND finished_at < ?").bind(cut(30)),
      this.db.prepare('DELETE FROM node_challenges WHERE expires_at < ?').bind(nowIso()),
      this.db.prepare('DELETE FROM pairing_tokens WHERE expires_at < ?').bind(cut(30)),
      this.db.prepare('DELETE FROM artifact_manifests WHERE created_at < ?').bind(cut(90)),
      this.db.prepare('DELETE FROM log_chunks WHERE created_at < ?').bind(cut(90)),
      this.db.prepare('DELETE FROM cloud_usage_events WHERE started_at < ?').bind(cut(400)),
      this.db.prepare('DELETE FROM audit_events WHERE at < ?').bind(cut(400)),
      this.db.prepare('DELETE FROM repository_leases WHERE released_at IS NOT NULL AND released_at < ?').bind(cut(30)),
    ]);
    return { r2Keys: [...oldObjects.results, ...goneObjects.results].map((r) => r.r2_key) };
  }
}

interface RepoRow {
  node_id: string;
  local_id: string;
  name: string;
  fingerprint: string;
  remote_host: string | null;
  default_branch: string | null;
}

function toRepo(r: RepoRow): NodeRepository {
  return { localId: r.local_id, name: r.name, fingerprint: r.fingerprint, remoteHost: r.remote_host, defaultBranch: r.default_branch };
}

function toView(r: NodeRow, repositories: NodeRepository[]): CloudNodeView {
  return {
    id: r.id,
    label: r.label,
    status: nodeStatus(r),
    os: r.os,
    appVersion: r.app_version,
    protocolVersion: r.protocol_version,
    updateRequired: r.protocol_version !== null && r.protocol_version < REMOTE_MIN_PROTOCOL_VERSION,
    capabilities: r.capabilities ? (JSON.parse(r.capabilities) as NodeCapabilities) : null,
    repositories,
    keyVersion: r.key_version,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    connectedAt: r.connected_at,
    revokedAt: r.revoked_at,
  };
}

export interface CommandRow {
  id: string;
  node_id: string;
  op: string;
  params: string;
  query: string;
  body: string | null;
  idempotency_key: string;
  payload_hash: string;
  precondition: string | null;
  status: CommandStatus;
  created_by: string;
  created_at: string;
  expires_at: string;
  delivered_at: string | null;
  claimed_at: string | null;
  finished_at: string | null;
  result_status: number | null;
  result_body: string | null;
  error_code: string | null;
  error_message: string | null;
  task_id: string | null;
  lease_fingerprint: string | null;
}

/** What a command row says as the answer to a wait: its outcome or error when it has finished. */
export function waitFromRow(row: CommandRow): CommandWait {
  const view = commandView(row);
  if (row.status !== 'succeeded' && row.status !== 'failed') return { status: row.status, command: view };
  return {
    status: row.status,
    command: view,
    ...(row.result_status ? { outcome: { httpStatus: row.result_status, body: row.result_body ? JSON.parse(row.result_body) : null } } : {}),
    ...(row.error_code ? { error: { code: row.error_code, message: row.error_message ?? '' } } : {}),
  };
}

export function commandView(r: CommandRow): CloudCommandView {
  return {
    id: r.id,
    nodeId: r.node_id,
    op: r.op,
    status: r.status,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    finishedAt: r.finished_at,
    httpStatus: r.result_status,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    taskId: r.task_id,
  };
}

/** Rebuild the wire command from its row (for delivery). */
export function commandFromRow(r: CommandRow): RemoteCommand {
  return {
    id: r.id,
    nodeId: r.node_id,
    op: r.op,
    params: JSON.parse(r.params) as Record<string, string>,
    query: JSON.parse(r.query) as Record<string, string>,
    ...(r.body !== null ? { body: JSON.parse(r.body) as unknown } : {}),
    idempotencyKey: r.idempotency_key,
    payloadHash: r.payload_hash,
    precondition: r.precondition ? (JSON.parse(r.precondition) as RemoteCommand['precondition']) : null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}
