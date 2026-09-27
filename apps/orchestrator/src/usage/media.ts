import { randomUUID } from 'node:crypto';
import { formatUsd, NANOS_PER_USD, type MediaSettings, type MediaSpendEvent, type MediaSpendStatus } from '@acc/shared';
import type { CostEstimate, OperationResult } from '@acc/tools';
import type { Db } from '../db/database.js';

type Row = Record<string, any>;

/** What counts against a budget: everything except a released reservation. */
const COUNTED = "status IN ('reserved', 'charged', 'unknown')";

function toEvent(r: Row): MediaSpendEvent {
  return {
    id: r.id,
    taskId: r.task_id,
    stageId: r.stage_id,
    executionId: r.execution_id,
    capability: r.capability,
    provider: r.provider,
    model: r.model,
    unit: r.unit,
    units: r.units,
    estimatedNanos: r.estimated_nanos,
    basis: r.basis,
    status: r.status,
    jobId: r.job_id,
    origin: r.origin,
    createdAt: r.created_at,
    settledAt: r.settled_at,
  };
}

/**
 * The media spend ledger (migration 20, docs/systems/design-agent.md). A row
 * is written when a paid call is reserved and settled once when it ends; rows
 * are never deleted. Amounts are estimates in nano-dollars: the vendor's bill
 * is the truth.
 */
export class MediaLedger {
  constructor(private readonly db: Db) {}

  /** Counted spend (reserved, charged or unknown) for a task and/or a window. */
  spentNanos(filter: { taskId?: string | null; from?: string; to?: string } = {}): number {
    const where = [COUNTED];
    const args: unknown[] = [];
    if (filter.taskId !== undefined) {
      where.push(filter.taskId === null ? 'task_id IS NULL' : 'task_id = ?');
      if (filter.taskId !== null) args.push(filter.taskId);
    }
    if (filter.from) {
      where.push('created_at >= ?');
      args.push(filter.from);
    }
    if (filter.to) {
      where.push('created_at < ?');
      args.push(filter.to);
    }
    const row = this.db.prepare(`SELECT COALESCE(SUM(estimated_nanos), 0) AS n FROM media_usage_events WHERE ${where.join(' AND ')}`).get(...args) as Row;
    return Number(row.n);
  }

  insert(e: Omit<MediaSpendEvent, 'id' | 'createdAt' | 'settledAt' | 'status' | 'jobId'>): MediaSpendEvent {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO media_usage_events (id, task_id, stage_id, execution_id, capability, provider, model, unit, units, estimated_nanos, basis, status, job_id, origin, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, ?, ?, NULL)`,
      )
      .run(id, e.taskId, e.stageId, e.executionId, e.capability, e.provider, e.model, e.unit, e.units, e.estimatedNanos, e.basis, e.origin, createdAt);
    return this.get(id)!;
  }

  /** Settle a reservation once; a settled row never changes again. */
  settle(id: string, status: Exclude<MediaSpendStatus, 'reserved'>, jobId: string | null): void {
    this.db.prepare("UPDATE media_usage_events SET status = ?, job_id = ?, settled_at = ? WHERE id = ? AND status = 'reserved'").run(status, jobId, new Date().toISOString(), id);
  }

  get(id: string): MediaSpendEvent | null {
    const row = this.db.prepare('SELECT * FROM media_usage_events WHERE id = ?').get(id) as Row | undefined;
    return row ? toEvent(row) : null;
  }

  list(filter: { taskId?: string; from?: string; limit?: number } = {}): MediaSpendEvent[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.taskId) {
      where.push('task_id = ?');
      args.push(filter.taskId);
    }
    if (filter.from) {
      where.push('created_at >= ?');
      args.push(filter.from);
    }
    const sql = `SELECT * FROM media_usage_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, Math.min(filter.limit ?? 200, 1000)) as Row[]).map(toEvent);
  }
}

export interface MediaBudgetCheck {
  /** Media budgets that stop runs: their label, amount and what their window has counted so far. */
  stopping(): Array<{ label: string; amountNanos: number; spentNanos: number }>;
}

export interface SpendRequest {
  taskId: string | null;
  stageId: string | null;
  executionId: string;
  capability: string;
  provider: string;
  origin: string;
  estimate: CostEstimate;
}

/**
 * The spend gate ToolService runs before a paid call. Fails closed: paid
 * generation off, a negative or unreadable estimate, a task budget it does not
 * fit, or a stopping media budget it does not fit — each refuses the call. The
 * check and the reservation happen in one transaction, so two calls at once
 * cannot both fit into the last dollar.
 */
export class MediaSpendGate {
  constructor(
    private readonly db: Db,
    readonly ledger: MediaLedger,
    private readonly budgets: MediaBudgetCheck,
    private readonly settings: () => MediaSettings,
  ) {}

  prices(): Readonly<Record<string, number>> {
    return this.settings().prices;
  }

  reserve(req: SpendRequest): { ok: true; id: string } | { ok: false; reason: string } {
    const media = this.settings();
    if (!media.allowPaidGeneration) return { ok: false, reason: 'Paid generation is off. The operator can turn it on in Settings → Media (with a budget per task); report this as an operator decision.' };
    const usd = req.estimate.usd;
    if (!Number.isFinite(usd) || usd < 0) return { ok: false, reason: 'This call has no usable cost estimate, so it is not run.' };
    const nanos = Math.round(usd * NANOS_PER_USD);
    return this.db.transaction(() => {
      if (req.taskId) {
        const cap = Math.round(media.taskBudgetUsd * NANOS_PER_USD);
        const spent = this.ledger.spentNanos({ taskId: req.taskId });
        if (spent + nanos > cap) {
          return { ok: false as const, reason: `This call (estimated ${formatUsd(nanos)}) would take ${req.taskId}'s media spend to ${formatUsd(spent + nanos)}, over its ${formatUsd(cap)} budget (Settings → Media). Report it as an operator decision.` };
        }
      }
      for (const b of this.budgets.stopping()) {
        if (b.spentNanos + nanos > b.amountNanos) {
          return { ok: false as const, reason: `This call (estimated ${formatUsd(nanos)}) would exceed the ${b.label} (${formatUsd(b.spentNanos)} of ${formatUsd(b.amountNanos)} used). Its policy stops paid calls; raise it in Usage & Costs → Budgets.` };
        }
      }
      const row = this.ledger.insert({ taskId: req.taskId, stageId: req.stageId, executionId: req.executionId, capability: req.capability, provider: req.provider, model: req.estimate.model, unit: req.estimate.unit, units: req.estimate.units, estimatedNanos: nanos, basis: req.estimate.basis, origin: req.origin });
      return { ok: true as const, id: row.id };
    })();
  }

  /**
   * After the call: a job id in the result means the vendor accepted it
   * (charged). Without one, a refusal the vendor gave before billing (bad
   * input, no key, not installed, outside the repository) releases the
   * reservation; anything else — a timeout, an unanswered submission — may
   * have been billed, so it stays counted as unknown.
   */
  settle(id: string, result: OperationResult): void {
    const output = (result.output ?? {}) as { jobId?: unknown };
    const jobId = typeof output.jobId === 'string' ? output.jobId.slice(0, 4000) : null;
    const refusedBeforeBilling = ['INVALID_INPUT', 'AUTH_REQUIRED', 'NOT_INSTALLED', 'OUTSIDE_ROOT', 'PROTECTED_PATH', 'DENIED'].includes(result.error?.code ?? '');
    const status = jobId || result.ok ? 'charged' : refusedBeforeBilling ? 'released' : 'unknown';
    this.ledger.settle(id, status, jobId);
  }
}
