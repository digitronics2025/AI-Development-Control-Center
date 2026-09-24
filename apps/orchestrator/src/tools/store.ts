import type {
  CapabilityEscalation,
  CredentialEventView,
  CredentialKind,
  McpServerView,
  PermissionLevel,
  RecoveryAttempt,
  TaskProcess,
  TerminalSession,
  ToolExecution,
  VaultAuthority,
  VaultLinkState,
} from '@acc/shared';
import type { ToolHealthRecord } from '@acc/tools';
import type { Db } from '../db/database.js';
import { now } from '../store/store.js';

/**
 * Persistence for the tool layer (migration 5). Everything written here is
 * already redacted and bounded by the caller; credential values exist only
 * as ciphertext.
 */

type Row = Record<string, any>;

function parse<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
const json = (v: unknown) => JSON.stringify(v ?? null);

export interface CredentialRecord {
  id: string;
  name: string;
  kind: CredentialKind;
  envVar: string | null;
  description: string;
  repositoryIds: string[] | null;
  ciphertext: string;
  iv: string;
  tag: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface McpServerRecord extends Omit<McpServerView, 'health'> {
  health: McpServerView['health'];
}

export interface TaskProcessRecord extends TaskProcess {
  /** Process creation time as the OS reports it; with pid and command, proves identity before a kill. */
  processStartedAt: string | null;
}

const toExecution = (r: Row): ToolExecution => ({
  id: r.id,
  taskId: r.task_id,
  stageId: r.stage_id,
  sessionId: r.session_id,
  capability: r.capability,
  providerId: r.provider_id,
  origin: r.origin,
  decision: r.decision,
  routeReason: r.route_reason,
  permissionLevel: r.permission_level,
  risk: r.risk,
  effects: parse(r.effects, []),
  status: r.status,
  summary: r.summary,
  errorCode: r.error_code,
  inputSummary: r.input_summary,
  attempt: r.attempt,
  recoveryOf: r.recovery_of,
  artifacts: parse(r.artifacts, []),
  filesChanged: parse(r.files_changed, []),
  networkTargets: parse(r.network_targets, []),
  evidence: parse(r.evidence, []),
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  durationMs: r.duration_ms,
});

const toProcess = (r: Row): TaskProcessRecord => ({
  id: r.id,
  taskId: r.task_id,
  stageId: r.stage_id,
  name: r.name,
  command: r.command,
  cwd: r.cwd,
  pid: r.pid,
  port: r.port,
  url: r.url,
  status: r.status,
  startedAt: r.started_at,
  stoppedAt: r.stopped_at,
  exitCode: r.exit_code,
  stopReason: r.stop_reason,
  processStartedAt: r.process_started_at,
});

const toTerminal = (r: Row): TerminalSession => ({
  id: r.id,
  taskId: r.task_id,
  shell: r.shell,
  cwd: r.cwd,
  pid: r.pid,
  ownerKind: r.owner_kind,
  status: r.status,
  cols: r.cols,
  rows: r.rows,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  exitCode: r.exit_code,
});

const toRecovery = (r: Row): RecoveryAttempt => ({
  id: r.id,
  taskId: r.task_id,
  stageId: r.stage_id,
  command: r.command,
  category: r.category,
  strategy: r.strategy,
  status: r.status,
  detail: r.detail,
  evidence: r.evidence,
  attempt: r.attempt,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

const toEscalation = (r: Row): CapabilityEscalation => ({
  id: r.id,
  taskId: r.task_id,
  stageId: r.stage_id,
  capability: r.capability,
  decision: r.decision,
  reason: r.reason,
  permissionLevel: r.permission_level,
  createdAt: r.created_at,
});

const toMcp = (r: Row): McpServerRecord => ({
  id: r.id,
  name: r.name,
  transport: r.transport,
  command: r.command,
  args: parse(r.args, []),
  url: r.url,
  envCredentials: parse(r.env_credentials, {}),
  enabled: r.enabled === 1,
  permissionLevel: r.permission_level,
  allowedTools: parse(r.allowed_tools, null),
  timeoutMs: r.timeout_ms,
  health: parse(r.health, null),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toCredential = (r: Row): CredentialRecord => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  envVar: r.env_var,
  description: r.description,
  repositoryIds: parse(r.repository_ids, null),
  ciphertext: r.ciphertext,
  iv: r.iv,
  tag: r.tag,
  fingerprint: r.fingerprint,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at,
});

export class ToolStore {
  constructor(private readonly db: Db) {}

  // ----- registry snapshot and health ------------------------------------------------

  syncRegistry(tools: Array<{ id: string; name: string; category: string; builtin: boolean; source: string; capabilities: Array<{ id: string; level: PermissionLevel }> }>): void {
    const ts = now();
    this.db.transaction(() => {
      const keep = new Set(tools.map((t) => t.id));
      for (const row of this.db.prepare('SELECT id FROM tools').all() as Row[]) if (!keep.has(row.id)) this.db.prepare('DELETE FROM tools WHERE id = ?').run(row.id);
      const upsert = this.db.prepare(
        'INSERT INTO tools (id, name, category, builtin, source, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category, builtin = excluded.builtin, source = excluded.source, updated_at = excluded.updated_at',
      );
      const cap = this.db.prepare('INSERT INTO tool_capabilities (tool_id, capability_id, permission_level) VALUES (?, ?, ?)');
      for (const t of tools) {
        upsert.run(t.id, t.name, t.category, t.builtin ? 1 : 0, t.source, ts);
        this.db.prepare('DELETE FROM tool_capabilities WHERE tool_id = ?').run(t.id);
        for (const c of t.capabilities) cap.run(t.id, c.id, c.level);
      }
    })();
  }

  saveHealth(h: ToolHealthRecord): void {
    this.db
      .prepare(
        `INSERT INTO tool_health (tool_id, state, installed, version, path, message, auth, checked_at, auth_checked_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tool_id) DO UPDATE SET state = excluded.state, installed = excluded.installed, version = excluded.version, path = excluded.path, message = excluded.message,
           auth = excluded.auth, checked_at = excluded.checked_at, auth_checked_at = excluded.auth_checked_at, duration_ms = excluded.duration_ms`,
      )
      .run(h.providerId, h.state, h.installed ? 1 : 0, h.version, h.path, h.message, json(h.auth), h.checkedAt, h.authCheckedAt, h.durationMs);
  }

  loadHealth(): ToolHealthRecord[] {
    return (this.db.prepare('SELECT * FROM tool_health').all() as Row[]).map((r) => ({
      providerId: r.tool_id,
      state: r.state,
      installed: r.installed === 1,
      version: r.version,
      path: r.path,
      message: r.message,
      auth: parse(r.auth, { required: false, state: 'not_required', message: null }),
      checkedAt: r.checked_at,
      authCheckedAt: r.auth_checked_at,
      durationMs: r.duration_ms ?? 0,
    }));
  }

  usage(): Map<string, { uses: number; lastUsedAt: string | null }> {
    const rows = this.db.prepare('SELECT provider_id, COUNT(*) AS n, MAX(started_at) AS last FROM tool_executions WHERE provider_id IS NOT NULL GROUP BY provider_id').all() as Row[];
    return new Map(rows.map((r) => [r.provider_id, { uses: r.n, lastUsedAt: r.last }]));
  }

  // ----- executions ----------------------------------------------------------------------

  insertExecution(e: ToolExecution): void {
    this.db
      .prepare(
        `INSERT INTO tool_executions (id, task_id, stage_id, session_id, capability, provider_id, origin, decision, route_reason, permission_level, risk, effects, status, summary,
           error_code, input_summary, attempt, recovery_of, artifacts, files_changed, network_targets, evidence, started_at, finished_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.taskId,
        e.stageId,
        e.sessionId,
        e.capability,
        e.providerId,
        e.origin,
        e.decision,
        e.routeReason,
        e.permissionLevel,
        e.risk,
        json(e.effects),
        e.status,
        e.summary,
        e.errorCode,
        e.inputSummary,
        e.attempt,
        e.recoveryOf,
        json(e.artifacts),
        json(e.filesChanged),
        json(e.networkTargets),
        json(e.evidence),
        e.startedAt,
        e.finishedAt,
        e.durationMs,
      );
  }

  finishExecution(id: string, patch: Pick<ToolExecution, 'status' | 'summary' | 'errorCode' | 'artifacts' | 'filesChanged' | 'networkTargets' | 'evidence' | 'finishedAt' | 'durationMs'>): ToolExecution {
    this.db
      .prepare('UPDATE tool_executions SET status = ?, summary = ?, error_code = ?, artifacts = ?, files_changed = ?, network_targets = ?, evidence = ?, finished_at = ?, duration_ms = ? WHERE id = ?')
      .run(patch.status, patch.summary, patch.errorCode, json(patch.artifacts), json(patch.filesChanged), json(patch.networkTargets), json(patch.evidence), patch.finishedAt, patch.durationMs, id);
    return this.execution(id)!;
  }

  execution(id: string): ToolExecution | null {
    const r = this.db.prepare('SELECT * FROM tool_executions WHERE id = ?').get(id) as Row | undefined;
    return r ? toExecution(r) : null;
  }

  /** Every call made in these sessions, oldest first (Ask shows them as an answer's sources). */
  listExecutionsBySession(sessionIds: readonly string[], limit = 500): ToolExecution[] {
    if (!sessionIds.length) return [];
    const marks = sessionIds.map(() => '?').join(', ');
    return (this.db.prepare(`SELECT * FROM tool_executions WHERE session_id IN (${marks}) ORDER BY started_at LIMIT ?`).all(...sessionIds, limit) as Row[]).map(toExecution);
  }

  listExecutions(filter: { taskId?: string; capability?: string; limit?: number; before?: string } = {}): ToolExecution[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.taskId) {
      where.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.capability) {
      where.push('capability = ?');
      params.push(filter.capability);
    }
    if (filter.before) {
      where.push('started_at < ?');
      params.push(filter.before);
    }
    const sql = `SELECT * FROM tool_executions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, filter.limit ?? 200) as Row[]).map(toExecution);
  }

  /** Mark executions left running by a crash. */
  interruptRunningExecutions(): number {
    return this.db.prepare("UPDATE tool_executions SET status = 'cancelled', summary = COALESCE(summary, 'Interrupted by an orchestrator restart'), finished_at = ? WHERE status = 'running'").run(now()).changes;
  }

  /** Evidence lines of successful executions of a capability prefix for a task (verification matrix). */
  evidenceFor(taskId: string, capabilityPrefix: string): string[] {
    const rows = this.db.prepare("SELECT evidence FROM tool_executions WHERE task_id = ? AND capability LIKE ? AND status = 'succeeded' ORDER BY started_at").all(taskId, `${capabilityPrefix}%`) as Row[];
    return rows.flatMap((r) => parse<string[]>(r.evidence, []));
  }

  // ----- processes ------------------------------------------------------------------------

  insertProcess(p: TaskProcessRecord): void {
    this.db
      .prepare('INSERT INTO task_processes (id, task_id, stage_id, name, command, cwd, pid, process_started_at, port, url, status, started_at, stopped_at, exit_code, stop_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, p.taskId, p.stageId, p.name, p.command, p.cwd, p.pid, p.processStartedAt, p.port, p.url, p.status, p.startedAt, p.stoppedAt, p.exitCode, p.stopReason);
  }

  updateProcess(id: string, patch: Partial<TaskProcessRecord>): TaskProcessRecord {
    const cols: Record<string, unknown> = {};
    if (patch.pid !== undefined) cols.pid = patch.pid;
    if (patch.processStartedAt !== undefined) cols.process_started_at = patch.processStartedAt;
    if (patch.status !== undefined) cols.status = patch.status;
    if (patch.stoppedAt !== undefined) cols.stopped_at = patch.stoppedAt;
    if (patch.exitCode !== undefined) cols.exit_code = patch.exitCode;
    if (patch.stopReason !== undefined) cols.stop_reason = patch.stopReason;
    const keys = Object.keys(cols);
    if (keys.length) this.db.prepare(`UPDATE task_processes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k]), id);
    return this.process(id)!;
  }

  process(id: string): TaskProcessRecord | null {
    const r = this.db.prepare('SELECT * FROM task_processes WHERE id = ?').get(id) as Row | undefined;
    return r ? toProcess(r) : null;
  }

  listProcesses(filter: { taskId?: string | null; live?: boolean } = {}): TaskProcessRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.taskId !== undefined) {
      where.push(filter.taskId === null ? 'task_id IS NULL' : 'task_id = ?');
      if (filter.taskId !== null) params.push(filter.taskId);
    }
    if (filter.live) where.push("status IN ('starting', 'running', 'healthy', 'unhealthy')");
    return (this.db.prepare(`SELECT * FROM task_processes ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT 500`).all(...params) as Row[]).map(toProcess);
  }

  // ----- terminals ------------------------------------------------------------------------

  insertTerminal(t: TerminalSession): void {
    this.db
      .prepare('INSERT INTO pty_sessions (id, task_id, shell, cwd, pid, owner_kind, status, cols, rows, started_at, ended_at, exit_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.id, t.taskId, t.shell, t.cwd, t.pid, t.ownerKind, t.status, t.cols, t.rows, t.startedAt, t.endedAt, t.exitCode);
  }

  updateTerminal(id: string, patch: Partial<TerminalSession>): TerminalSession | null {
    const cols: Record<string, unknown> = {};
    if (patch.status !== undefined) cols.status = patch.status;
    if (patch.endedAt !== undefined) cols.ended_at = patch.endedAt;
    if (patch.exitCode !== undefined) cols.exit_code = patch.exitCode;
    if (patch.cols !== undefined) cols.cols = patch.cols;
    if (patch.rows !== undefined) cols.rows = patch.rows;
    const keys = Object.keys(cols);
    if (keys.length) this.db.prepare(`UPDATE pty_sessions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k]), id);
    return this.terminal(id);
  }

  terminal(id: string): TerminalSession | null {
    const r = this.db.prepare('SELECT * FROM pty_sessions WHERE id = ?').get(id) as Row | undefined;
    return r ? toTerminal(r) : null;
  }

  listTerminals(filter: { taskId?: string; running?: boolean } = {}): TerminalSession[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.taskId) {
      where.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.running) where.push("status = 'running'");
    return (this.db.prepare(`SELECT * FROM pty_sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT 200`).all(...params) as Row[]).map(toTerminal);
  }

  // ----- recovery and escalations ------------------------------------------------------------

  insertRecovery(a: RecoveryAttempt): void {
    this.db
      .prepare('INSERT INTO recovery_attempts (id, task_id, stage_id, command, category, strategy, status, detail, evidence, attempt, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.taskId, a.stageId, a.command, a.category, a.strategy, a.status, a.detail, a.evidence, a.attempt, a.createdAt, a.finishedAt);
  }

  finishRecovery(id: string, status: RecoveryAttempt['status'], detail: string): RecoveryAttempt {
    this.db.prepare('UPDATE recovery_attempts SET status = ?, detail = ?, finished_at = ? WHERE id = ?').run(status, detail, now(), id);
    return toRecovery(this.db.prepare('SELECT * FROM recovery_attempts WHERE id = ?').get(id) as Row);
  }

  listRecovery(taskId: string): RecoveryAttempt[] {
    return (this.db.prepare('SELECT * FROM recovery_attempts WHERE task_id = ? ORDER BY created_at').all(taskId) as Row[]).map(toRecovery);
  }

  insertEscalation(e: CapabilityEscalation & { sessionId: string | null }): void {
    this.db
      .prepare('INSERT INTO capability_escalations (id, task_id, stage_id, session_id, capability, decision, reason, permission_level, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.id, e.taskId, e.stageId, e.sessionId, e.capability, e.decision, e.reason, e.permissionLevel, e.createdAt);
  }

  listEscalations(taskId: string): CapabilityEscalation[] {
    return (this.db.prepare('SELECT * FROM capability_escalations WHERE task_id = ? ORDER BY created_at').all(taskId) as Row[]).map(toEscalation);
  }

  // ----- MCP servers ------------------------------------------------------------------------

  listMcpServers(): McpServerRecord[] {
    return (this.db.prepare('SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE').all() as Row[]).map(toMcp);
  }

  mcpServer(id: string): McpServerRecord | null {
    const r = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as Row | undefined;
    return r ? toMcp(r) : null;
  }

  upsertMcpServer(s: McpServerRecord): void {
    this.db
      .prepare(
        `INSERT INTO mcp_servers (id, name, transport, command, args, url, env_credentials, enabled, permission_level, allowed_tools, timeout_ms, health, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, transport = excluded.transport, command = excluded.command, args = excluded.args, url = excluded.url,
           env_credentials = excluded.env_credentials, enabled = excluded.enabled, permission_level = excluded.permission_level, allowed_tools = excluded.allowed_tools,
           timeout_ms = excluded.timeout_ms, health = excluded.health, updated_at = excluded.updated_at`,
      )
      .run(s.id, s.name, s.transport, s.command, json(s.args), s.url, json(s.envCredentials), s.enabled ? 1 : 0, s.permissionLevel, s.allowedTools ? json(s.allowedTools) : null, s.timeoutMs, s.health ? json(s.health) : null, s.createdAt, s.updatedAt);
  }

  deleteMcpServer(id: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  }

  // ----- credentials ---------------------------------------------------------------------------

  listCredentials(): CredentialRecord[] {
    return (this.db.prepare('SELECT * FROM credential_references ORDER BY name COLLATE NOCASE').all() as Row[]).map(toCredential);
  }

  credential(id: string): CredentialRecord | null {
    const r = this.db.prepare('SELECT * FROM credential_references WHERE id = ? OR name = ?').get(id, id) as Row | undefined;
    return r ? toCredential(r) : null;
  }

  upsertCredential(c: CredentialRecord): void {
    this.db
      .prepare(
        `INSERT INTO credential_references (id, name, kind, env_var, description, repository_ids, ciphertext, iv, tag, fingerprint, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, env_var = excluded.env_var, description = excluded.description, repository_ids = excluded.repository_ids,
           ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
      )
      .run(c.id, c.name, c.kind, c.envVar, c.description, c.repositoryIds ? json(c.repositoryIds) : null, c.ciphertext, c.iv, c.tag, c.fingerprint, c.createdAt, c.updatedAt, c.lastUsedAt);
  }

  touchCredential(id: string): void {
    this.db.prepare('UPDATE credential_references SET last_used_at = ? WHERE id = ?').run(now(), id);
  }

  deleteCredential(id: string): void {
    this.db.prepare('DELETE FROM credential_references WHERE id = ?').run(id);
  }

  // ----- MyVault bridge (migration 7): links, trusted origins, credential events ----------

  /** Run several writes atomically (a generated credential and its link land together or not at all). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  vaultLink(credentialId: string): VaultLinkRecord | null {
    const r = this.db.prepare('SELECT * FROM credential_vault_links WHERE credential_id = ?').get(credentialId) as Row | undefined;
    return r ? toVaultLink(r) : null;
  }

  vaultLinkByItem(origin: string, vaultId: string, itemId: string): VaultLinkRecord | null {
    const r = this.db.prepare('SELECT * FROM credential_vault_links WHERE origin = ? AND vault_id = ? AND vault_item_id = ?').get(origin, vaultId, itemId) as Row | undefined;
    return r ? toVaultLink(r) : null;
  }

  listVaultLinks(): VaultLinkRecord[] {
    return (this.db.prepare('SELECT * FROM credential_vault_links').all() as Row[]).map(toVaultLink);
  }

  upsertVaultLink(l: VaultLinkRecord): void {
    this.db
      .prepare(
        `INSERT INTO credential_vault_links (credential_id, authority, origin, vault_id, vault_item_id, state, synced_fingerprint, vault_fingerprint, replace_vault_fingerprint, vault_updated_at, first_synced_at, last_synced_at, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(credential_id) DO UPDATE SET authority = excluded.authority, origin = excluded.origin, vault_id = excluded.vault_id, vault_item_id = excluded.vault_item_id,
           state = excluded.state, synced_fingerprint = excluded.synced_fingerprint, vault_fingerprint = excluded.vault_fingerprint, replace_vault_fingerprint = excluded.replace_vault_fingerprint, vault_updated_at = excluded.vault_updated_at, first_synced_at = excluded.first_synced_at,
           last_synced_at = excluded.last_synced_at, last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(l.credentialId, l.authority, l.origin, l.vaultId, l.itemId, l.state, l.syncedFingerprint, l.vaultFingerprint, l.replaceVaultFingerprint, l.vaultUpdatedAt, l.firstSyncedAt, l.lastSyncedAt, l.lastError, l.createdAt, l.updatedAt);
  }

  listTrustedOrigins(): TrustedOriginRecord[] {
    return (this.db.prepare('SELECT * FROM vault_bridge_origins ORDER BY trusted_at').all() as Row[]).map((r) => ({ origin: r.origin, vaultId: r.vault_id, trustedAt: r.trusted_at, lastConnectedAt: r.last_connected_at }));
  }

  trustOrigin(origin: string): void {
    this.db.prepare('INSERT INTO vault_bridge_origins (origin, trusted_at) VALUES (?, ?) ON CONFLICT(origin) DO NOTHING').run(origin, now());
  }

  untrustOrigin(origin: string): boolean {
    return this.db.prepare('DELETE FROM vault_bridge_origins WHERE origin = ?').run(origin).changes > 0;
  }

  vaultBridgeIdentity(): { publicKey: string; sealed: { ciphertext: string; iv: string; tag: string } } | null {
    const r = this.db.prepare('SELECT * FROM vault_bridge_identity WHERE id = 1').get() as Row | undefined;
    return r ? { publicKey: r.public_key, sealed: { ciphertext: r.private_key_ciphertext, iv: r.private_key_iv, tag: r.private_key_tag } } : null;
  }

  /** The first identity wins; a concurrent second one is dropped, and both callers then read the winner. */
  insertVaultBridgeIdentity(publicKey: string, sealed: { ciphertext: string; iv: string; tag: string }): void {
    this.db
      .prepare('INSERT INTO vault_bridge_identity (id, public_key, private_key_ciphertext, private_key_iv, private_key_tag, created_at) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
      .run(publicKey, sealed.ciphertext, sealed.iv, sealed.tag, now());
  }

  // --- MyVault delivery box (migration 10) ---------------------------------

  depositTargets(): DepositTargetRecord[] {
    return (this.db.prepare('SELECT * FROM vault_deposit_targets ORDER BY updated_at DESC').all() as Row[]).map(depositTarget);
  }

  depositTarget(origin: string): DepositTargetRecord | null {
    const r = this.db.prepare('SELECT * FROM vault_deposit_targets WHERE origin = ?').get(origin) as Row | undefined;
    return r ? depositTarget(r) : null;
  }

  upsertDepositTarget(t: DepositTargetRecord): void {
    this.db
      .prepare(
        `INSERT INTO vault_deposit_targets (origin, vault_id, key_id, public_key, sender_id, token_ciphertext, token_iv, token_tag, last_error, last_error_kind, last_deposit_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(origin) DO UPDATE SET vault_id = excluded.vault_id, key_id = excluded.key_id, public_key = excluded.public_key, sender_id = excluded.sender_id,
           token_ciphertext = excluded.token_ciphertext, token_iv = excluded.token_iv, token_tag = excluded.token_tag, last_error = excluded.last_error,
           last_error_kind = excluded.last_error_kind, last_deposit_at = excluded.last_deposit_at, updated_at = excluded.updated_at`,
      )
      .run(t.origin, t.vaultId, t.keyId, t.publicKey, t.senderId, t.sealedToken.ciphertext, t.sealedToken.iv, t.sealedToken.tag, t.lastError, t.lastErrorKind, t.lastDepositAt, t.createdAt, t.updatedAt);
  }

  noteDepositTarget(origin: string, patch: { lastError?: string | null; lastErrorKind?: DepositTargetRecord['lastErrorKind']; lastDepositAt?: string }): void {
    const current = this.depositTarget(origin);
    if (current) this.upsertDepositTarget({ ...current, ...patch, updatedAt: now() });
  }

  removeDepositTarget(origin: string): void {
    this.db.prepare('DELETE FROM vault_deposit_targets WHERE origin = ?').run(origin);
  }

  deposits(filter: { status?: DepositRecord['status']; credentialId?: string } = {}): DepositRecord[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    if (filter.credentialId) {
      where.push('credential_id = ?');
      args.push(filter.credentialId);
    }
    const sql = `SELECT * FROM vault_deposits${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => ({
      id: r.id,
      credentialId: r.credential_id,
      origin: r.origin,
      vaultId: r.vault_id,
      fingerprint: r.fingerprint,
      status: r.status,
      receiptStatus: r.receipt_status,
      detail: r.detail,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  upsertDeposit(d: DepositRecord): void {
    this.db
      .prepare(
        `INSERT INTO vault_deposits (id, credential_id, origin, vault_id, fingerprint, status, receipt_status, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, receipt_status = excluded.receipt_status, detail = excluded.detail, updated_at = excluded.updated_at`,
      )
      .run(d.id, d.credentialId, d.origin, d.vaultId, d.fingerprint, d.status, d.receiptStatus, d.detail, d.createdAt, d.updatedAt);
  }

  touchOrigin(origin: string, vaultId: string): void {
    this.db.prepare('UPDATE vault_bridge_origins SET vault_id = ?, last_connected_at = ? WHERE origin = ?').run(vaultId, now(), origin);
  }

  insertCredentialEvent(e: CredentialEventRecord): void {
    this.db
      .prepare('INSERT INTO credential_events (id, credential_id, credential_name, operation, direction, status, task_id, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.id, e.credentialId, e.credentialName, e.operation, e.direction, e.status, e.taskId, e.target, e.detail, e.createdAt);
  }

  listCredentialEvents(filter: { credentialId?: string; limit?: number } = {}): CredentialEventRecord[] {
    const rows = filter.credentialId
      ? (this.db.prepare('SELECT * FROM credential_events WHERE credential_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(filter.credentialId, filter.limit ?? 100) as Row[])
      : (this.db.prepare('SELECT * FROM credential_events ORDER BY created_at DESC, rowid DESC LIMIT ?').all(filter.limit ?? 100) as Row[]);
    return rows.map((r) => ({ id: r.id, credentialId: r.credential_id, credentialName: r.credential_name, operation: r.operation, direction: r.direction, status: r.status, taskId: r.task_id, target: r.target, detail: r.detail, createdAt: r.created_at }));
  }
}

/** Where to leave sealed secrets for one MyVault: its Worker (the trusted origin), delivery key and sender token. */
export interface DepositTargetRecord {
  origin: string;
  vaultId: string;
  keyId: string;
  publicKey: string;
  senderId: string;
  sealedToken: { ciphertext: string; iv: string; tag: string };
  lastError: string | null;
  /** `auth`: MyVault refused the credential — nothing is sent until MyVault offers a new one; `transient`: try again later. */
  lastErrorKind: 'auth' | 'transient' | null;
  lastDepositAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One secret left in a delivery box. `sending`: id reserved, not yet confirmed stored; `stored`: in the box; `collected`/`refused`: receipt read. */
export interface DepositRecord {
  id: string;
  credentialId: string;
  origin: string;
  vaultId: string;
  fingerprint: string;
  status: 'sending' | 'stored' | 'collected' | 'refused';
  receiptStatus: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

function depositTarget(r: Row): DepositTargetRecord {
  return {
    origin: r.origin,
    vaultId: r.vault_id,
    keyId: r.key_id,
    publicKey: r.public_key,
    senderId: r.sender_id,
    sealedToken: { ciphertext: r.token_ciphertext, iv: r.token_iv, tag: r.token_tag },
    lastError: r.last_error,
    lastErrorKind: r.last_error_kind,
    lastDepositAt: r.last_deposit_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface VaultLinkRecord {
  credentialId: string;
  authority: VaultAuthority;
  /** The trusted MyVault origin; null for a generated secret never synchronized yet. */
  origin: string | null;
  vaultId: string | null;
  itemId: string | null;
  state: VaultLinkState;
  /** Fingerprint of the value both sides last agreed on. */
  syncedFingerprint: string | null;
  /** Fingerprint of the value MyVault last reported holding. */
  vaultFingerprint: string | null;
  /** Set by "keep the Control Center value": the next push may replace exactly this MyVault value. */
  replaceVaultFingerprint: string | null;
  vaultUpdatedAt: string | null;
  firstSyncedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TrustedOriginRecord {
  origin: string;
  vaultId: string | null;
  trustedAt: string;
  lastConnectedAt: string | null;
}

export type CredentialEventRecord = CredentialEventView;

const toVaultLink = (r: Row): VaultLinkRecord => ({
  credentialId: r.credential_id,
  authority: r.authority,
  origin: r.origin,
  vaultId: r.vault_id,
  itemId: r.vault_item_id,
  state: r.state,
  syncedFingerprint: r.synced_fingerprint,
  vaultFingerprint: r.vault_fingerprint,
  replaceVaultFingerprint: r.replace_vault_fingerprint,
  vaultUpdatedAt: r.vault_updated_at,
  firstSyncedAt: r.first_synced_at,
  lastSyncedAt: r.last_synced_at,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
