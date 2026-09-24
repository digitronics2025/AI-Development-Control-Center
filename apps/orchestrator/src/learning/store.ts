import type {
  FindingConfidence,
  FindingKind,
  FindingStatus,
  ImprovementKind,
  ImprovementStatus,
  LearningFinding,
  LearningImprovement,
  LearningLogEntry,
  LearningProposal,
  LearningReview,
  LearningScope,
  LearningSignal,
  ReviewStatus,
} from '@acc/shared';
import { LIVE_IMPROVEMENT_STATUSES } from '@acc/shared';
import type { Db } from '../db/database.js';
import { newId, now } from '../store/store.js';

type Row = Record<string, any>;

function parse<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function toReview(r: Row): LearningReview {
  return {
    taskId: r.task_id,
    repositoryId: r.repository_id,
    status: r.status,
    reviewer: r.reviewer,
    signals: parse<LearningSignal[]>(r.signals, []),
    findingIds: parse<string[]>(r.finding_ids, []),
    summary: r.summary,
    error: r.error,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

function toFinding(r: Row): LearningFinding {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    kind: r.kind,
    scope: r.scope,
    repositoryId: r.repository_id,
    title: r.title,
    detail: r.detail,
    proposal: parse<LearningProposal | null>(r.proposal, null),
    confidence: r.confidence,
    observed: Boolean(r.observed),
    occurrences: r.occurrences,
    taskCount: r.task_count,
    status: r.status,
    statusReason: r.status_reason,
    improvementId: r.improvement_id,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    updatedAt: r.updated_at,
  };
}

function toImprovement(r: Row): LearningImprovement {
  return {
    id: r.id,
    findingId: r.finding_id,
    fingerprint: r.fingerprint,
    kind: r.kind,
    scope: r.scope,
    repositoryId: r.repository_id,
    title: r.title,
    content: r.content,
    source: r.source,
    contentHash: r.content_hash,
    status: r.status,
    trial: { target: r.trial_target, seen: r.trial_seen, recurrences: r.trial_recurrences },
    reason: r.reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    revertedAt: r.reverted_at,
    revertedBy: r.reverted_by,
  };
}

export interface FindingInput {
  fingerprint: string;
  kind: FindingKind;
  scope: LearningScope;
  repositoryId: string | null;
  title: string;
  detail: string;
  proposal: LearningProposal | null;
  confidence: FindingConfidence;
  observed: boolean;
}

/** Persistence for the learning loop (migration 11). Rows hold structured summaries only. */
export class LearningStore {
  constructor(readonly db: Db) {}

  // ----- reviews -------------------------------------------------------------

  review(taskId: string): LearningReview | null {
    const row = this.db.prepare('SELECT * FROM learning_reviews WHERE task_id = ?').get(taskId) as Row | undefined;
    return row ? toReview(row) : null;
  }

  /** A review row for a finished task; an existing one is reset to pending (a re-review). */
  queueReview(taskId: string, repositoryId: string | null): LearningReview {
    this.db
      .prepare(
        `INSERT INTO learning_reviews (task_id, repository_id, status, created_at) VALUES (?, ?, 'pending', ?)
         ON CONFLICT(task_id) DO UPDATE SET status = 'pending', error = NULL, finished_at = NULL`,
      )
      .run(taskId, repositoryId, now());
    return this.review(taskId)!;
  }

  updateReview(taskId: string, patch: Partial<Pick<LearningReview, 'status' | 'reviewer' | 'signals' | 'findingIds' | 'summary' | 'error' | 'finishedAt'>>): void {
    const map: Record<string, [string, (v: any) => unknown]> = {
      status: ['status', (v) => v],
      reviewer: ['reviewer', (v) => v],
      signals: ['signals', (v) => JSON.stringify(v)],
      findingIds: ['finding_ids', (v) => JSON.stringify(v)],
      summary: ['summary', (v) => v],
      error: ['error', (v) => v],
      finishedAt: ['finished_at', (v) => v],
    };
    const entries = Object.entries(patch).filter(([k]) => k in map);
    if (!entries.length) return;
    this.db
      .prepare(`UPDATE learning_reviews SET ${entries.map(([k]) => `${map[k]![0]} = ?`).join(', ')} WHERE task_id = ?`)
      .run(...entries.map(([k, v]) => map[k]![1](v)), taskId);
  }

  reviewsWithStatus(statuses: ReviewStatus[]): LearningReview[] {
    return (this.db.prepare(`SELECT * FROM learning_reviews WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at`).all(...statuses) as Row[]).map(toReview);
  }

  listReviews(limit = 50): LearningReview[] {
    return (this.db.prepare('SELECT * FROM learning_reviews ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(toReview);
  }

  reviewCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM learning_reviews WHERE status IN ('done', 'skipped')").get() as { n: number }).n;
  }

  // ----- findings ------------------------------------------------------------

  finding(id: string): LearningFinding | null {
    const row = this.db.prepare('SELECT * FROM learning_findings WHERE id = ?').get(id) as Row | undefined;
    return row ? toFinding(row) : null;
  }

  findingByFingerprint(fingerprint: string): LearningFinding | null {
    const row = this.db.prepare('SELECT * FROM learning_findings WHERE fingerprint = ?').get(fingerprint) as Row | undefined;
    return row ? toFinding(row) : null;
  }

  /**
   * Record that a task showed this finding. The first sighting creates it;
   * later ones count once per task (a re-review of the same task adds nothing)
   * and keep the newest wording. Returns the finding and whether this task is new to it.
   */
  observe(input: FindingInput, taskId: string, signalIds: string[]): { finding: LearningFinding; newTask: boolean } {
    return this.db.transaction(() => {
      const at = now();
      let existing = this.findingByFingerprint(input.fingerprint);
      if (!existing) {
        const id = newId();
        this.db
          .prepare(
            `INSERT INTO learning_findings (id, fingerprint, kind, scope, repository_id, title, detail, proposal, confidence, observed, occurrences, task_count, status, first_seen_at, last_seen_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'open', ?, ?, ?)`,
          )
          .run(id, input.fingerprint, input.kind, input.scope, input.repositoryId, input.title, input.detail, input.proposal ? JSON.stringify(input.proposal) : null, input.confidence, input.observed ? 1 : 0, at, at, at);
        existing = this.finding(id)!;
      }
      const inserted = this.db
        .prepare('INSERT OR IGNORE INTO learning_observations (finding_id, task_id, signal_ids, created_at) VALUES (?, ?, ?, ?)')
        .run(existing.id, taskId, JSON.stringify(signalIds), at).changes > 0;
      if (inserted) {
        this.db
          .prepare(
            `UPDATE learning_findings SET occurrences = occurrences + 1, task_count = task_count + 1, last_seen_at = ?, updated_at = ?,
               title = ?, detail = ?, proposal = COALESCE(?, proposal), observed = MAX(observed, ?),
               confidence = CASE WHEN ? = 'HIGH' OR confidence = 'HIGH' THEN 'HIGH' WHEN ? = 'MEDIUM' OR confidence = 'MEDIUM' THEN 'MEDIUM' ELSE 'LOW' END
             WHERE id = ?`,
          )
          .run(at, at, input.title, input.detail, input.proposal ? JSON.stringify(input.proposal) : null, input.observed ? 1 : 0, input.confidence, input.confidence, existing.id);
      }
      return { finding: this.finding(existing.id)!, newTask: inserted };
    })();
  }

  setFindingStatus(id: string, status: FindingStatus, reason: string | null, improvementId?: string | null): LearningFinding | null {
    this.db
      .prepare(`UPDATE learning_findings SET status = ?, status_reason = ?, improvement_id = COALESCE(?, improvement_id), updated_at = ? WHERE id = ?`)
      .run(status, reason, improvementId ?? null, now(), id);
    return this.finding(id);
  }

  listFindings(filter: { statuses?: FindingStatus[]; repositoryId?: string | null; limit?: number } = {}): LearningFinding[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      params.push(...filter.statuses);
    }
    if (filter.repositoryId !== undefined) {
      where.push("(scope = 'global' OR repository_id = ?)");
      params.push(filter.repositoryId);
    }
    const sql = `SELECT * FROM learning_findings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_seen_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, filter.limit ?? 200) as Row[]).map(toFinding);
  }

  /** Tasks a finding was seen in, oldest first. */
  observationTasks(findingId: string): string[] {
    return (this.db.prepare('SELECT task_id FROM learning_observations WHERE finding_id = ? ORDER BY created_at').all(findingId) as Row[]).map((r) => r.task_id);
  }

  // ----- improvements --------------------------------------------------------

  improvement(id: string): LearningImprovement | null {
    const row = this.db.prepare('SELECT * FROM learning_improvements WHERE id = ?').get(id) as Row | undefined;
    return row ? toImprovement(row) : null;
  }

  insertImprovement(input: Omit<LearningImprovement, 'id' | 'createdAt' | 'updatedAt' | 'revertedAt' | 'revertedBy' | 'trial'> & { trialTarget: number }): LearningImprovement {
    const id = newId();
    const at = now();
    this.db
      .prepare(
        `INSERT INTO learning_improvements (id, finding_id, fingerprint, kind, scope, repository_id, title, content, source, content_hash, status, trial_target, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.findingId, input.fingerprint, input.kind, input.scope, input.repositoryId, input.title, input.content, input.source, input.contentHash, input.status, input.trialTarget, input.reason, at, at);
    return this.improvement(id)!;
  }

  updateImprovement(id: string, patch: { status?: ImprovementStatus; reason?: string; seen?: number; recurrences?: number; revertedBy?: 'chairman' | 'user' }): LearningImprovement | null {
    const at = now();
    const current = this.improvement(id);
    if (!current) return null;
    const reverted = patch.revertedBy ? at : current.revertedAt;
    this.db
      .prepare(`UPDATE learning_improvements SET status = ?, reason = ?, trial_seen = ?, trial_recurrences = ?, reverted_at = ?, reverted_by = ?, updated_at = ? WHERE id = ?`)
      .run(
        patch.status ?? current.status,
        patch.reason ?? current.reason,
        patch.seen ?? current.trial.seen,
        patch.recurrences ?? current.trial.recurrences,
        reverted,
        patch.revertedBy ?? current.revertedBy,
        at,
        id,
      );
    return this.improvement(id);
  }

  listImprovements(filter: { statuses?: readonly ImprovementStatus[]; limit?: number } = {}): LearningImprovement[] {
    const statuses = filter.statuses ?? [];
    const sql = `SELECT * FROM learning_improvements ${statuses.length ? `WHERE status IN (${statuses.map(() => '?').join(',')})` : ''} ORDER BY created_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...statuses, filter.limit ?? 200) as Row[]).map(toImprovement);
  }

  /** Improvements that reach a task in this repository (its own and global ones). */
  liveFor(repositoryId: string | null, kinds?: readonly ImprovementKind[]): LearningImprovement[] {
    return this.listImprovements({ statuses: LIVE_IMPROVEMENT_STATUSES }).filter(
      (i) => (i.scope === 'global' || i.repositoryId === repositoryId) && (!kinds || kinds.includes(i.kind)),
    );
  }

  /** A fingerprint the Chairman once adopted and then undid (or a person undid): never adopted again automatically. */
  wasUndone(fingerprint: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM learning_improvements WHERE fingerprint = ? AND status IN ('reverted', 'ineffective') LIMIT 1").get(fingerprint));
  }

  /** Improvements adopted since the start of the local day. */
  actionsSince(since: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM learning_improvements WHERE created_at >= ?').get(since) as { n: number }).n;
  }

  // ----- log -----------------------------------------------------------------

  log(entry: Omit<LearningLogEntry, 'id' | 'at'>): LearningLogEntry {
    const at = now();
    const info = this.db
      .prepare('INSERT INTO learning_log (at, kind, task_id, finding_id, improvement_id, message) VALUES (?, ?, ?, ?, ?, ?)')
      .run(at, entry.kind, entry.taskId, entry.findingId, entry.improvementId, entry.message.slice(0, 600));
    return { ...entry, id: Number(info.lastInsertRowid), at };
  }

  listLog(limit = 100): LearningLogEntry[] {
    return (this.db.prepare('SELECT * FROM learning_log ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      id: r.id,
      at: r.at,
      kind: r.kind,
      taskId: r.task_id,
      findingId: r.finding_id,
      improvementId: r.improvement_id,
      message: r.message,
    }));
  }
}
