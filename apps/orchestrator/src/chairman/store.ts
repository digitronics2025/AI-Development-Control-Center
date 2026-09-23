import type {
  ChairmanAction,
  ChairmanActionStatus,
  ChairmanDecision,
  ChairmanHealth,
  ChairmanMessage,
  ChairmanStatus,
  FailureCategory,
  TaskCheckpoint,
  TaskContract,
} from '@acc/shared';
import type { Db } from '../db/database.js';
import { newId, now } from '../store/store.js';
import type { FailureSource } from './signatures.js';

type Row = Record<string, any>;

function parse<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export interface ChairmanSessionRecord {
  taskId: string;
  status: ChairmanStatus;
  health: ChairmanHealth;
  strategySummary: string | null;
  /** Strategies already tried, so a recovery cycle never replays one (§5.3). */
  strategyFingerprints: string[];
  lastDecisionId: string | null;
  lastRecoveryReason: string | null;
  degradedReason: string | null;
  conversationSummary: string | null;
  updatedAt: string;
}

export interface FailureRecord {
  id: string;
  taskId: string;
  stageId: string | null;
  stageKey: string;
  source: FailureSource;
  category: FailureCategory;
  signature: string;
  hash: string;
  failureCount: number | null;
  message: string;
  recoveryCycle: number;
  createdAt: string;
}

export interface CheckpointRecord extends TaskCheckpoint {
  ref: string;
}

const toSession = (r: Row): ChairmanSessionRecord => ({
  taskId: r.task_id,
  status: r.status,
  health: r.health,
  strategySummary: r.strategy_summary,
  strategyFingerprints: parse(r.strategy_fingerprints, []),
  lastDecisionId: r.last_decision_id,
  lastRecoveryReason: r.last_recovery_reason,
  degradedReason: r.degraded_reason,
  conversationSummary: r.conversation_summary,
  updatedAt: r.updated_at,
});

const toMessage = (r: Row): ChairmanMessage => ({
  id: r.id,
  taskId: r.task_id,
  seq: r.seq,
  role: r.role,
  kind: r.kind,
  body: r.body,
  intent: r.intent,
  status: r.status,
  decisionId: r.decision_id,
  actionId: r.action_id,
  createdAt: r.created_at,
});

const toDecision = (r: Row): ChairmanDecision => ({
  id: r.id,
  taskId: r.task_id,
  source: r.source,
  trigger: r.trigger,
  taskVersion: r.task_version,
  summary: r.summary,
  reasoningSummary: r.reasoning_summary,
  decision: r.decision,
  expectedResult: r.expected_result,
  hardBlocker: r.hard_blocker === 1,
  health: r.health,
  reasoner: r.reasoner,
  strategyFingerprint: r.strategy_fingerprint,
  createdAt: r.created_at,
});

const toAction = (r: Row): ChairmanAction => ({
  id: r.id,
  taskId: r.task_id,
  decisionId: r.decision_id,
  messageId: r.message_id,
  type: r.type,
  params: parse(r.params, {}),
  initiator: r.initiator,
  source: r.source,
  taskVersion: r.task_version,
  status: r.status,
  reason: r.reason,
  result: r.result,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});

const toFailure = (r: Row): FailureRecord => ({
  id: r.id,
  taskId: r.task_id,
  stageId: r.stage_id,
  stageKey: r.stage_key,
  source: r.source,
  category: r.category,
  signature: r.signature,
  hash: r.hash,
  failureCount: r.failure_count,
  message: r.message,
  recoveryCycle: r.recovery_cycle,
  createdAt: r.created_at,
});

const toCheckpoint = (r: Row): CheckpointRecord => ({
  id: r.id,
  taskId: r.task_id,
  seq: r.seq,
  label: r.label,
  reason: r.reason,
  commit: r.commit_hash,
  ref: r.ref,
  head: r.head,
  stageKey: r.stage_key,
  createdAt: r.created_at,
});

const toContract = (r: Row): TaskContract => ({
  taskId: r.task_id,
  version: r.version,
  goal: r.goal,
  successCriteria: parse(r.success_criteria, []),
  scope: parse(r.scope, { repository: '', workflow: '' }),
  autonomyMode: r.autonomy_mode,
  constraints: parse(r.constraints, []),
  reason: r.reason,
  createdAt: r.created_at,
});

/** Persistence for everything the Chairman owns. Workflow state stays in `tasks`. */
export class ChairmanStore {
  constructor(private readonly db: Db) {}

  // ----- contracts ------------------------------------------------------------

  insertContract(c: TaskContract): TaskContract {
    this.db
      .prepare('INSERT INTO task_contracts (task_id, version, goal, success_criteria, scope, autonomy_mode, constraints, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.taskId, c.version, c.goal, JSON.stringify(c.successCriteria), JSON.stringify(c.scope), c.autonomyMode, JSON.stringify(c.constraints), c.reason, c.createdAt);
    return c;
  }

  latestContract(taskId: string): TaskContract | null {
    const row = this.db.prepare('SELECT * FROM task_contracts WHERE task_id = ? ORDER BY version DESC LIMIT 1').get(taskId) as Row | undefined;
    return row ? toContract(row) : null;
  }

  // ----- sessions ---------------------------------------------------------------

  session(taskId: string): ChairmanSessionRecord {
    const row = this.db.prepare('SELECT * FROM chairman_sessions WHERE task_id = ?').get(taskId) as Row | undefined;
    if (row) return toSession(row);
    this.db.prepare("INSERT OR IGNORE INTO chairman_sessions (task_id, status, updated_at) VALUES (?, 'idle', ?)").run(taskId, now());
    return toSession(this.db.prepare('SELECT * FROM chairman_sessions WHERE task_id = ?').get(taskId) as Row);
  }

  updateSession(taskId: string, patch: Partial<Omit<ChairmanSessionRecord, 'taskId' | 'updatedAt'>>): ChairmanSessionRecord {
    this.session(taskId);
    const map: Record<string, [string, (v: any) => unknown]> = {
      status: ['status', (v) => v],
      health: ['health', (v) => v],
      strategySummary: ['strategy_summary', (v) => v],
      strategyFingerprints: ['strategy_fingerprints', (v) => JSON.stringify(v)],
      lastDecisionId: ['last_decision_id', (v) => v],
      lastRecoveryReason: ['last_recovery_reason', (v) => v],
      degradedReason: ['degraded_reason', (v) => v],
      conversationSummary: ['conversation_summary', (v) => v],
    };
    const entries = Object.entries(patch).filter(([k]) => map[k]);
    const sets = [...entries.map(([k]) => `${map[k]![0]} = ?`), 'updated_at = ?'];
    this.db.prepare(`UPDATE chairman_sessions SET ${sets.join(', ')} WHERE task_id = ?`).run(...entries.map(([k, v]) => map[k]![1](v)), now(), taskId);
    return this.session(taskId);
  }

  // ----- messages -------------------------------------------------------------------

  insertMessage(m: Omit<ChairmanMessage, 'id' | 'seq' | 'createdAt'> & { clientMessageId?: string | null }): ChairmanMessage {
    const id = newId();
    const createdAt = now();
    this.db.transaction(() => {
      const seq = ((this.db.prepare('SELECT MAX(seq) AS s FROM chairman_messages WHERE task_id = ?').get(m.taskId) as Row).s ?? 0) + 1;
      this.db
        .prepare(
          `INSERT INTO chairman_messages (id, task_id, seq, role, kind, body, intent, status, client_message_id, decision_id, action_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, m.taskId, seq, m.role, m.kind, m.body, m.intent, m.status, m.clientMessageId ?? null, m.decisionId, m.actionId, createdAt);
    })();
    return this.message(id)!;
  }

  message(id: string): ChairmanMessage | null {
    const row = this.db.prepare('SELECT * FROM chairman_messages WHERE id = ?').get(id) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  messageByClientId(taskId: string, clientMessageId: string): ChairmanMessage | null {
    const row = this.db.prepare('SELECT * FROM chairman_messages WHERE task_id = ? AND client_message_id = ?').get(taskId, clientMessageId) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  updateMessage(id: string, patch: { status?: ChairmanMessage['status']; intent?: ChairmanMessage['intent'] }): ChairmanMessage {
    if (patch.status) this.db.prepare('UPDATE chairman_messages SET status = ? WHERE id = ?').run(patch.status, id);
    if (patch.intent !== undefined) this.db.prepare('UPDATE chairman_messages SET intent = ? WHERE id = ?').run(patch.intent, id);
    return this.message(id)!;
  }

  listMessages(taskId: string, opts: { after?: number; limit?: number } = {}): ChairmanMessage[] {
    const limit = Math.min(opts.limit ?? 200, 500);
    if (opts.after !== undefined) {
      return (this.db.prepare('SELECT * FROM chairman_messages WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(taskId, opts.after, limit) as Row[]).map(toMessage);
    }
    const rows = this.db.prepare('SELECT * FROM (SELECT * FROM chairman_messages WHERE task_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq').all(taskId, limit) as Row[];
    return rows.map(toMessage);
  }

  pendingUserMessages(): ChairmanMessage[] {
    return (this.db.prepare("SELECT * FROM chairman_messages WHERE role = 'user' AND status = 'pending' ORDER BY created_at, seq").all() as Row[]).map(toMessage);
  }

  // ----- decisions ------------------------------------------------------------------

  insertDecision(d: Omit<ChairmanDecision, 'id' | 'createdAt'>): ChairmanDecision {
    const rec: ChairmanDecision = { ...d, id: newId(), createdAt: now() };
    this.db
      .prepare(
        `INSERT INTO chairman_decisions (id, task_id, source, trigger, task_version, summary, reasoning_summary, decision, expected_result, hard_blocker, health, reasoner, strategy_fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.taskId,
        rec.source,
        rec.trigger,
        rec.taskVersion,
        rec.summary,
        rec.reasoningSummary,
        rec.decision,
        rec.expectedResult,
        rec.hardBlocker ? 1 : 0,
        rec.health,
        rec.reasoner,
        rec.strategyFingerprint,
        rec.createdAt,
      );
    return rec;
  }

  listDecisions(taskId: string, limit = 50): ChairmanDecision[] {
    return (this.db.prepare('SELECT * FROM (SELECT *, rowid AS rid FROM chairman_decisions WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, rid').all(taskId, limit) as Row[]).map(toDecision);
  }

  // ----- actions ------------------------------------------------------------------------

  insertAction(a: Omit<ChairmanAction, 'id' | 'createdAt' | 'finishedAt' | 'result'> & { idempotencyKey: string | null }): ChairmanAction {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO chairman_actions (id, task_id, decision_id, message_id, type, params, initiator, source, task_version, status, reason, result, idempotency_key, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
      )
      .run(id, a.taskId, a.decisionId, a.messageId, a.type, JSON.stringify(a.params), a.initiator, a.source, a.taskVersion, a.status, a.reason, a.idempotencyKey, now());
    return this.action(id)!;
  }

  action(id: string): ChairmanAction | null {
    const row = this.db.prepare('SELECT * FROM chairman_actions WHERE id = ?').get(id) as Row | undefined;
    return row ? toAction(row) : null;
  }

  actionByKey(taskId: string, key: string): ChairmanAction | null {
    const row = this.db.prepare('SELECT * FROM chairman_actions WHERE task_id = ? AND idempotency_key = ?').get(taskId, key) as Row | undefined;
    return row ? toAction(row) : null;
  }

  finishAction(id: string, status: ChairmanActionStatus, result: string | null, reason?: string | null): ChairmanAction {
    this.db.prepare('UPDATE chairman_actions SET status = ?, result = ?, reason = COALESCE(?, reason), finished_at = ? WHERE id = ?').run(status, result, reason ?? null, now(), id);
    return this.action(id)!;
  }

  listActions(taskId: string, limit = 100): ChairmanAction[] {
    return (this.db.prepare('SELECT * FROM (SELECT *, rowid AS rid FROM chairman_actions WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, rid').all(taskId, limit) as Row[]).map(toAction);
  }

  actionsForMessage(messageId: string): ChairmanAction[] {
    return (this.db.prepare('SELECT * FROM chairman_actions WHERE message_id = ? ORDER BY created_at, rowid').all(messageId) as Row[]).map(toAction);
  }

  // ----- failures ---------------------------------------------------------------------

  insertFailure(f: Omit<FailureRecord, 'id' | 'createdAt'>): FailureRecord {
    const rec: FailureRecord = { ...f, id: newId(), createdAt: now() };
    this.db
      .prepare(
        `INSERT INTO failure_signatures (id, task_id, stage_id, stage_key, source, category, signature, hash, failure_count, message, recovery_cycle, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rec.id, rec.taskId, rec.stageId, rec.stageKey, rec.source, rec.category, rec.signature, rec.hash, rec.failureCount, rec.message, rec.recoveryCycle, rec.createdAt);
    return rec;
  }

  listFailures(taskId: string, opts: { recoveryCycle?: number } = {}): FailureRecord[] {
    const rows =
      opts.recoveryCycle !== undefined
        ? this.db.prepare('SELECT * FROM failure_signatures WHERE task_id = ? AND recovery_cycle = ? ORDER BY created_at, rowid').all(taskId, opts.recoveryCycle)
        : this.db.prepare('SELECT * FROM failure_signatures WHERE task_id = ? ORDER BY created_at, rowid').all(taskId);
    return (rows as Row[]).map(toFailure);
  }

  // ----- checkpoints --------------------------------------------------------------------

  nextCheckpointSeq(taskId: string): number {
    return ((this.db.prepare('SELECT MAX(seq) AS s FROM task_checkpoints WHERE task_id = ?').get(taskId) as Row).s ?? 0) + 1;
  }

  insertCheckpoint(c: CheckpointRecord): CheckpointRecord {
    this.db
      .prepare('INSERT INTO task_checkpoints (id, task_id, seq, label, reason, commit_hash, ref, head, stage_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.id, c.taskId, c.seq, c.label, c.reason, c.commit, c.ref, c.head, c.stageKey, c.createdAt);
    return c;
  }

  listCheckpoints(taskId: string): CheckpointRecord[] {
    return (this.db.prepare('SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY seq').all(taskId) as Row[]).map(toCheckpoint);
  }

  checkpoint(id: string): CheckpointRecord | null {
    const row = this.db.prepare('SELECT * FROM task_checkpoints WHERE id = ?').get(id) as Row | undefined;
    return row ? toCheckpoint(row) : null;
  }

  lastLogAt(executionId: string): string | null {
    return (this.db.prepare('SELECT MAX(at) AS at FROM execution_logs WHERE execution_id = ?').get(executionId) as Row).at ?? null;
  }

  // ----- usage ------------------------------------------------------------------------------

  /** Agent runs and accumulated agent/command time: the objective basis for runtime limits. */
  usage(taskId: string): { agentRuns: number; workMs: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN kind = 'agent' THEN 1 ELSE 0 END) AS runs,
           SUM(COALESCE(duration_ms, CASE WHEN status = 'running' THEN (julianday('now') - julianday(started_at)) * 86400000 ELSE 0 END)) AS ms
         FROM executions WHERE task_id = ?`,
      )
      .get(taskId) as Row;
    return { agentRuns: row.runs ?? 0, workMs: Math.round(row.ms ?? 0) };
  }
}
