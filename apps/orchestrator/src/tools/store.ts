import type {
  CapabilityEscalation,
  CredentialKind,
  McpServerView,
  PermissionLevel,
  RecoveryAttempt,
  TaskProcess,
  TerminalSession,
  ToolExecution,
} from '@acc/shared';
import type { ToolHealthRecord } from '@acc/tools';
import type { Db } from '../db/database.js';
import { now } from '../store/store.js';

/**
 * Persistence for the tool layer (migration 4). Everything written here is
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
}
