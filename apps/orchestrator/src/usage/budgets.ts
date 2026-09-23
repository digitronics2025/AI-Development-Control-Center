import { randomUUID } from 'node:crypto';
import {
  formatUsd,
  NANOS_PER_USD,
  type Budget,
  type BudgetInput,
  type BudgetPeriod,
  type BudgetState,
  type BudgetStatus,
  type BudgetUpdate,
  type UsageFilter,
} from '@acc/shared';
import type { Db } from '../db/database.js';
import type { Store } from '../store/store.js';
import type { UsageQueries } from './queries.js';

type Row = Record<string, any>;

export class BudgetError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'DUPLICATE' | 'INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'BudgetError';
  }
}

function toBudget(r: Row): Budget {
  return {
    id: r.id,
    scopeType: r.scope_type,
    scopeId: r.scope_id,
    period: r.period,
    amountNanos: r.amount_nanos,
    currency: 'USD',
    warningThreshold: r.warning_threshold,
    criticalThreshold: r.critical_threshold,
    policy: r.policy,
    enabled: Boolean(r.enabled),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The current period's window in the orchestrator's local time; `total` has none. */
export function periodWindow(period: BudgetPeriod, now = new Date()): { start: Date; end: Date } | null {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  switch (period) {
    case 'day':
      return { start: new Date(y, m, d), end: new Date(y, m, d + 1) };
    case 'week': {
      const offset = (now.getDay() + 6) % 7; // weeks start on Monday
      return { start: new Date(y, m, d - offset), end: new Date(y, m, d - offset + 7) };
    }
    case 'month':
      return { start: new Date(y, m, 1), end: new Date(y, m + 1, 1) };
    case 'total':
      return null;
  }
}

export function budgetState(budget: Pick<Budget, 'amountNanos' | 'warningThreshold' | 'criticalThreshold'>, spentNanos: number): BudgetState {
  const ratio = spentNanos / budget.amountNanos;
  if (ratio >= 1) return 'exceeded';
  if (ratio >= budget.criticalThreshold) return 'critical';
  if (ratio >= budget.warningThreshold) return 'warning';
  return 'ok';
}

/** The attempt a new agent run would make, for budget enforcement. */
export interface RunScope {
  provider: string;
  projectId: string | null;
  model: string;
  agentId: string;
  taskId: string | null;
}

/**
 * Internal budgets (docs/systems/usage.md#budgets) — separate from provider
 * quotas. Spend is the sum of known attempt costs in scope and period;
 * attempts with an Unknown cost are counted and reported, never summed as 0.
 */
export class BudgetService {
  constructor(
    private readonly db: Db,
    private readonly store: Store,
    private readonly queries: UsageQueries,
  ) {}

  list(): Budget[] {
    return (this.db.prepare('SELECT * FROM budgets ORDER BY scope_type, scope_id, period').all() as Row[]).map(toBudget);
  }

  get(id: string): Budget {
    const row = this.db.prepare('SELECT * FROM budgets WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new BudgetError('NOT_FOUND', 'Budget not found');
    return toBudget(row);
  }

  create(input: BudgetInput): Budget {
    if (input.scopeType === 'TASK' && input.period !== 'total') throw new BudgetError('INVALID', 'A task budget covers the whole task: use the period "total".');
    const now = new Date().toISOString();
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO budgets (id, scope_type, scope_id, period, amount_nanos, warning_threshold, critical_threshold, policy, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.scopeType, input.scopeId, input.period, Math.round(input.amountUsd * NANOS_PER_USD), input.warningThreshold, input.criticalThreshold, input.policy, input.enabled ? 1 : 0, now, now);
    } catch (error) {
      if (/UNIQUE/i.test((error as Error).message)) throw new BudgetError('DUPLICATE', 'A budget for this scope and period already exists. Edit it instead of adding a second one.');
      throw error;
    }
    return this.get(id);
  }

  update(id: string, patch: BudgetUpdate): Budget {
    const current = this.get(id);
    const next = {
      amountNanos: patch.amountUsd !== undefined ? Math.round(patch.amountUsd * NANOS_PER_USD) : current.amountNanos,
      warning: patch.warningThreshold ?? current.warningThreshold,
      critical: patch.criticalThreshold ?? current.criticalThreshold,
      policy: patch.policy ?? current.policy,
      enabled: patch.enabled ?? current.enabled,
    };
    if (next.warning > next.critical) throw new BudgetError('INVALID', 'The warning threshold must not be above the critical one');
    this.db
      .prepare('UPDATE budgets SET amount_nanos = ?, warning_threshold = ?, critical_threshold = ?, policy = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(next.amountNanos, next.warning, next.critical, next.policy, next.enabled ? 1 : 0, new Date().toISOString(), id);
    return this.get(id);
  }

  delete(id: string): void {
    this.get(id);
    this.db.prepare('DELETE FROM budgets WHERE id = ?').run(id);
  }

  private scopeFilter(budget: Budget): Partial<UsageFilter> {
    switch (budget.scopeType) {
      case 'GLOBAL':
        return {};
      case 'PROVIDER':
        return { provider: budget.scopeId! };
      case 'PROJECT':
        return { projectId: budget.scopeId! };
      case 'MODEL':
        return { model: budget.scopeId! };
      case 'AGENT':
        return { agentId: budget.scopeId! };
      case 'TASK':
        return { taskId: budget.scopeId! };
    }
  }

  private scopeLabel(budget: Budget): string {
    const id = budget.scopeId ?? '';
    switch (budget.scopeType) {
      case 'GLOBAL':
        return 'All usage';
      case 'PROVIDER':
        return `Provider ${id}`;
      case 'PROJECT':
        return `Repository ${this.store.getRepository(id)?.name ?? id}`;
      case 'MODEL':
        return `Model ${id}`;
      case 'AGENT':
        return `Agent ${this.store.getAgent(id)?.name ?? id}`;
      case 'TASK': {
        const task = this.store.getTask(id);
        return task ? `${id} · ${task.title}` : `Task ${id}`;
      }
    }
  }

  status(budget: Budget, now = new Date()): BudgetStatus {
    const window = periodWindow(budget.period, now);
    const filter: Partial<UsageFilter> = { ...this.scopeFilter(budget), ...(window ? { from: window.start.toISOString(), to: window.end.toISOString() } : {}) };
    let spent: number;
    let unknown: number;
    if (budget.scopeType === 'MODEL') {
      // Only the model's own share of attempts that used several models.
      const row = this.queries.breakdown(filter, 'model').find((r) => r.key === budget.scopeId);
      spent = row?.totals.costNanos ?? 0;
      unknown = row?.totals.unknownCostRequests ?? 0;
    } else {
      const totals = this.queries.totals(filter);
      spent = totals.costNanos;
      unknown = totals.unknownCostRequests;
    }
    return {
      ...budget,
      scopeLabel: this.scopeLabel(budget),
      periodStart: window?.start.toISOString() ?? null,
      periodEnd: window?.end.toISOString() ?? null,
      spentNanos: spent,
      remainingNanos: Math.max(0, budget.amountNanos - spent),
      usedRatio: spent / budget.amountNanos,
      state: budgetState(budget, spent),
      unknownCostEvents: unknown,
    };
  }

  statuses(now = new Date()): BudgetStatus[] {
    return this.list().map((b) => this.status(b, now));
  }

  /** Budgets that apply to a task: global, its repository, and the task itself. */
  forTask(taskId: string, projectId: string | null): BudgetStatus[] {
    return this.list()
      .filter((b) => b.scopeType === 'GLOBAL' || (b.scopeType === 'TASK' && b.scopeId === taskId) || (b.scopeType === 'PROJECT' && b.scopeId === projectId))
      .map((b) => this.status(b));
  }

  private applies(budget: Budget, run: RunScope): boolean {
    switch (budget.scopeType) {
      case 'GLOBAL':
        return true;
      case 'PROVIDER':
        return budget.scopeId === run.provider;
      case 'PROJECT':
        return budget.scopeId === run.projectId;
      case 'MODEL':
        return budget.scopeId === run.model;
      case 'AGENT':
        return budget.scopeId === run.agentId;
      case 'TASK':
        return budget.scopeId === run.taskId;
    }
  }

  /**
   * Why a new run must not start, or null. Only enabled STOP_NEW_RUNS
   * budgets that are already exceeded stop a run; warnings never do.
   */
  blockReason(run: RunScope): string | null {
    for (const budget of this.list()) {
      if (!budget.enabled || budget.policy !== 'STOP_NEW_RUNS' || !this.applies(budget, run)) continue;
      const status = this.status(budget);
      if (status.state !== 'exceeded') continue;
      const period = budget.period === 'total' ? '' : ` ${budget.period}ly`.replace('dayly', 'daily');
      return `Budget exceeded: ${status.scopeLabel}${period} budget ${formatUsd(budget.amountNanos)}, spent ${formatUsd(status.spentNanos)}. Its policy stops new agent runs. Raise the budget or change its policy in Usage & Costs → Budgets, then resume.`;
    }
    return null;
  }
}
