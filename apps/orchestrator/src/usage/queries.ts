import type {
  UsageBreakdownRow,
  UsageEvent,
  UsageEventPage,
  UsageFilter,
  UsageStageCost,
  UsageTaskPage,
  UsageTaskRow,
  UsageTotals,
  UsageTrendPoint,
} from '@acc/shared';
import type { Db } from '../db/database.js';
import type { Store } from '../store/store.js';
import { toUsageEvent } from './ledger.js';

type Row = Record<string, any>;

/**
 * Read models over the raw ledger (docs/systems/usage.md#read-models).
 * Every figure is an indexed SQL aggregate of `usage_events` — there are no
 * stored rollups to drift, so a displayed total is always the sum of the
 * attempts behind it. Costs sum only attempts whose cost is known; the count
 * of Unknown ones travels with every total.
 */

const FROM = `usage_events e LEFT JOIN tasks t ON t.id = e.task_id LEFT JOIN repositories r ON r.id = e.project_id`;

export interface Where {
  sql: string;
  params: unknown[];
}

/** Server-side filtering. Every value is a bound parameter. */
export function whereClause(f: Partial<UsageFilter>): Where {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, ...values: unknown[]) => {
    clauses.push(sql);
    params.push(...values);
  };
  if (f.from) add('e.started_at >= ?', f.from);
  if (f.to) add('e.started_at < ?', f.to);
  if (f.provider) add('e.provider = ?', f.provider);
  // IN (subquery) is evaluated once; a correlated EXISTS let SQLite pick the model index per attempt.
  if (f.model) add('(e.model = ? OR e.provider_model_id = ? OR e.id IN (SELECT ml.event_id FROM usage_event_lines ml WHERE ml.model = ?))', f.model, f.model, f.model);
  if (f.agentId) add('e.agent_id = ?', f.agentId);
  if (f.projectId) add('e.project_id = ?', f.projectId);
  if (f.taskId) add('e.task_id = ?', f.taskId);
  if (f.runId) add('e.run_id = ?', f.runId);
  if (f.role) add('e.agent_role = ?', f.role);
  if (f.status) add('e.status = ?', f.status);
  if (f.costSource) add('e.cost_source = ?', f.costSource);
  if (f.effort) add('e.effort = ?', f.effort);
  if (f.taskType) add('e.workflow_id = ?', f.taskType);
  if (f.q) {
    const q = f.q.trim();
    add('(e.task_id = ? OR e.run_id = ? OR e.provider_request_id = ? OR e.idempotency_key = ? OR e.id = ? OR t.title LIKE ?)', q, q, q, q, q, `%${q.replace(/[%_]/g, '')}%`);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * Aggregate columns over a set of "units": attempts, or (for the model view)
 * one row per model an attempt used. A unit row exposes: status,
 * retry_index, duration_ms, the token columns, cost (null = unknown) and
 * cost_source.
 */
const TOTALS_COLUMNS = `
  COUNT(*) AS requests,
  COALESCE(SUM(u.status = 'succeeded'), 0) AS succeeded,
  COALESCE(SUM(u.status <> 'succeeded'), 0) AS failed,
  COALESCE(SUM(u.cost), 0) AS cost,
  COALESCE(SUM(u.cost IS NULL), 0) AS unknown_cost,
  COALESCE(SUM(u.cost IS NOT NULL AND u.cost_source = 'PROVIDER'), 0) AS provider_cost,
  COALESCE(SUM(u.cost IS NOT NULL AND u.cost_source = 'CALCULATED'), 0) AS calculated_cost,
  COALESCE(SUM(u.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(u.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(u.cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(u.cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(u.reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(SUM(u.total_tokens), 0) AS total_tokens,
  COALESCE(SUM(u.total_tokens IS NULL), 0) AS unreported,
  COALESCE(SUM(u.duration_ms), 0) AS duration_ms,
  COALESCE(SUM(CASE WHEN u.status <> 'succeeded' THEN u.cost END), 0) AS failed_cost,
  COALESCE(SUM(CASE WHEN u.retry_index > 0 THEN u.cost END), 0) AS retry_cost,
  COALESCE(SUM(u.retry_index > 0), 0) AS retry_requests`;

function toTotals(r: Row | undefined): UsageTotals {
  return {
    requests: r?.requests ?? 0,
    succeeded: r?.succeeded ?? 0,
    failed: r?.failed ?? 0,
    costNanos: r?.cost ?? 0,
    unknownCostRequests: r?.unknown_cost ?? 0,
    providerCostRequests: r?.provider_cost ?? 0,
    calculatedCostRequests: r?.calculated_cost ?? 0,
    inputTokens: r?.input_tokens ?? 0,
    outputTokens: r?.output_tokens ?? 0,
    cacheReadTokens: r?.cache_read_tokens ?? 0,
    cacheWriteTokens: r?.cache_write_tokens ?? 0,
    reasoningTokens: r?.reasoning_tokens ?? 0,
    totalTokens: r?.total_tokens ?? 0,
    unreportedTokenRequests: r?.unreported ?? 0,
    durationMs: r?.duration_ms ?? 0,
    failedCostNanos: r?.failed_cost ?? 0,
    retryCostNanos: r?.retry_cost ?? 0,
    retryRequests: r?.retry_requests ?? 0,
  };
}

export const EMPTY_TOTALS: UsageTotals = toTotals(undefined);

/** Attempts as units. */
function eventUnits(where: Where, keyExpr: string): Where {
  return {
    sql: `SELECT ${keyExpr} AS key, e.id, e.task_id, e.status, e.retry_index, e.duration_ms, e.input_tokens, e.output_tokens, e.cache_read_tokens,
            e.cache_write_tokens, e.reasoning_tokens, e.total_tokens, e.display_cost_nanos AS cost, e.cost_source, e.provider
          FROM ${FROM} ${where.sql}`,
    params: where.params,
  };
}

/**
 * One unit per model an attempt used. A line's cost counts only when its
 * attempt's cost is fully known, so model totals add up to the overall total.
 */
function modelUnits(where: Where): Where {
  return {
    sql: `WITH base AS (SELECT e.* FROM ${FROM} ${where.sql})
          SELECT l.model AS key, b.id, b.task_id, b.status, b.retry_index, b.duration_ms, l.input_tokens, l.output_tokens, l.cache_read_tokens,
                 l.cache_write_tokens, l.reasoning_tokens,
                 CASE WHEN COALESCE(l.input_tokens, l.output_tokens, l.cache_read_tokens, l.cache_write_tokens) IS NULL THEN NULL
                      ELSE COALESCE(l.input_tokens, 0) + COALESCE(l.output_tokens, 0) + COALESCE(l.cache_read_tokens, 0) + COALESCE(l.cache_write_tokens, 0) END AS total_tokens,
                 CASE WHEN b.display_cost_nanos IS NULL THEN NULL ELSE COALESCE(l.provider_cost_nanos, l.calculated_cost_nanos) END AS cost,
                 b.cost_source, b.provider
          FROM base b JOIN usage_event_lines l ON l.event_id = b.id
          UNION ALL
          SELECT COALESCE(b.provider_model_id, b.model) AS key, b.id, b.task_id, b.status, b.retry_index, b.duration_ms, b.input_tokens, b.output_tokens,
                 b.cache_read_tokens, b.cache_write_tokens, b.reasoning_tokens, b.total_tokens, b.display_cost_nanos AS cost, b.cost_source, b.provider
          FROM base b WHERE NOT EXISTS (SELECT 1 FROM usage_event_lines l WHERE l.event_id = b.id)`,
    params: [...where.params],
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export type BreakdownDimension = 'provider' | 'model' | 'agent' | 'role' | 'project' | 'taskType' | 'effort';

const KEY_EXPR: Record<Exclude<BreakdownDimension, 'model'>, string> = {
  provider: 'e.provider',
  agent: 'e.agent_id',
  role: "COALESCE(e.agent_role, 'unassigned')",
  project: "COALESCE(e.project_id, 'none')",
  taskType: "COALESCE(e.workflow_id, 'none')",
  effort: "COALESCE(e.effort, 'default')",
};

export class UsageQueries {
  constructor(
    private readonly db: Db,
    private readonly store: Store,
  ) {}

  totals(f: Partial<UsageFilter>): UsageTotals {
    const units = eventUnits(whereClause(f), "''");
    return toTotals(this.db.prepare(`SELECT ${TOTALS_COLUMNS} FROM (${units.sql}) u`).get(...units.params) as Row);
  }

  /** Sums per value of one dimension, with transparent per-group metrics. */
  breakdown(f: Partial<UsageFilter>, dimension: BreakdownDimension): UsageBreakdownRow[] {
    const where = whereClause(f);
    const units = dimension === 'model' ? modelUnits(where) : eventUnits(where, KEY_EXPR[dimension]);
    const groups = this.db.prepare(`SELECT u.key, ${TOTALS_COLUMNS} FROM (${units.sql}) u GROUP BY u.key`).all(...units.params) as Row[];
    const perTask = this.db
      .prepare(
        `SELECT u.key, u.task_id, SUM(u.cost) AS cost, SUM(u.cost IS NULL) AS unknown, tk.status AS task_status
         FROM (${units.sql}) u LEFT JOIN tasks tk ON tk.id = u.task_id
         WHERE u.task_id IS NOT NULL GROUP BY u.key, u.task_id`,
      )
      .all(...units.params) as Row[];
    const latency = this.db.prepare(`SELECT u.key, u.duration_ms FROM (${units.sql}) u`).all(...units.params) as Row[];
    const extra = dimension === 'model' ? (this.db.prepare(`SELECT u.key, MIN(u.provider) AS provider FROM (${units.sql}) u GROUP BY u.key`).all(...units.params) as Row[]) : [];
    const grand = groups.reduce((sum, g) => sum + (g.cost ?? 0), 0);
    const labels = this.labels(dimension, groups.map((g) => String(g.key)));
    return groups
      .map((g) => {
        const totals = toTotals(g);
        const tasks = perTask.filter((t) => t.key === g.key);
        const knownTaskCosts = tasks.filter((t) => !t.unknown).map((t) => t.cost ?? 0);
        const successful = tasks.filter((t) => t.task_status === 'COMPLETED');
        const successfulCost = successful.reduce((sum, t) => sum + (t.cost ?? 0), 0);
        const tokenBase = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
        const row: UsageBreakdownRow = {
          key: String(g.key),
          label: labels.get(String(g.key)) ?? String(g.key),
          totals,
          tasks: tasks.length,
          medianTaskCostNanos: median(knownTaskCosts),
          costPerSuccessfulTaskNanos: successful.length ? Math.round(successfulCost / successful.length) : null,
          retryRate: totals.requests ? totals.retryRequests / totals.requests : null,
          failureRate: totals.requests ? totals.failed / totals.requests : null,
          medianLatencyMs: median(latency.filter((l) => l.key === g.key).map((l) => l.duration_ms as number)),
          cacheHitRate: tokenBase ? totals.cacheReadTokens / tokenBase : null,
          shareOfCost: grand ? totals.costNanos / grand : null,
        };
        const provider = extra.find((x) => x.key === g.key)?.provider;
        if (provider) row.extra = { provider };
        return row;
      })
      .sort((a, b) => b.totals.costNanos - a.totals.costNanos || b.totals.totalTokens - a.totals.totalTokens);
  }

  /** Display names for grouping keys. */
  private labels(dimension: BreakdownDimension, keys: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (dimension === 'project') {
      for (const key of keys) {
        if (key === 'none') out.set(key, 'No repository');
        else out.set(key, this.store.getRepository(key)?.name ?? `${key} (removed)`);
      }
    }
    if (dimension === 'agent') for (const key of keys) out.set(key, this.store.getAgent(key)?.name ?? key);
    if (dimension === 'role') for (const key of keys) out.set(key, key === 'unassigned' ? 'No role' : key.charAt(0).toUpperCase() + key.slice(1));
    if (dimension === 'taskType') for (const key of keys) out.set(key, key === 'none' ? 'Outside a workflow' : (this.store.getWorkflow(key)?.name ?? key));
    return out;
  }

  /**
   * Totals per hour (ranges up to two days), day (up to 92 days) or week
   * (Monday-based, labelled by its Monday), in the orchestrator's local time.
   */
  trend(f: Partial<UsageFilter>): UsageTrendPoint[] {
    const span = f.from && f.to ? new Date(f.to).getTime() - new Date(f.from).getTime() : Infinity;
    const bucket =
      span <= 2 * 86_400_000
        ? "strftime('%Y-%m-%dT%H', e.started_at, 'localtime')"
        : span <= 92 * 86_400_000
          ? "date(e.started_at, 'localtime')"
          : "date(e.started_at, 'localtime', '-' || ((CAST(strftime('%w', e.started_at, 'localtime') AS INTEGER) + 6) % 7) || ' days')";
    const where = whereClause(f);
    return (
      this.db
        .prepare(
          `SELECT ${bucket} AS bucket, COALESCE(SUM(e.display_cost_nanos), 0) AS cost, COALESCE(SUM(e.total_tokens), 0) AS tokens, COUNT(*) AS requests,
                  COALESCE(SUM(e.display_cost_nanos IS NULL), 0) AS unknown
           FROM ${FROM} ${where.sql} GROUP BY bucket ORDER BY bucket`,
        )
        .all(...where.params) as Row[]
    ).map((r) => ({ bucket: r.bucket, costNanos: r.cost, totalTokens: r.tokens, requests: r.requests, unknownCostRequests: r.unknown }));
  }

  private taskRows(rows: Row[], f: Partial<UsageFilter>): UsageTaskRow[] {
    if (!rows.length) return [];
    // Models and agents of every listed task in one pass (no query per task).
    const where = whereClause(f);
    const pairs: Row[] = [];
    for (let i = 0; i < rows.length; i += 500) {
      const listed = rows.slice(i, i + 500).map((r) => r.task_id as string);
      const scope = `${where.sql ? `${where.sql} AND` : 'WHERE'} e.task_id IN (${listed.map(() => '?').join(', ')})`;
      pairs.push(
        ...(this.db
          .prepare(
            `SELECT DISTINCT e.task_id AS task, COALESCE(l.model, e.provider_model_id, e.model) AS m, e.agent_id AS a
             FROM ${FROM} LEFT JOIN usage_event_lines l ON l.event_id = e.id ${scope}`,
          )
          .all(...where.params, ...listed) as Row[]),
      );
    }
    const modelsOf = new Map<string, Set<string>>();
    const agentsOf = new Map<string, Set<string>>();
    for (const p of pairs) {
      if (!modelsOf.has(p.task)) modelsOf.set(p.task, new Set());
      if (!agentsOf.has(p.task)) agentsOf.set(p.task, new Set());
      modelsOf.get(p.task)!.add(p.m);
      agentsOf.get(p.task)!.add(p.a);
    }
    return rows.map((r) => {
      const models = [...(modelsOf.get(r.task_id) ?? [])];
      const agents = [...(agentsOf.get(r.task_id) ?? [])];
      return {
        taskId: r.task_id,
        taskTitle: r.task_title ?? null,
        projectId: r.project_id ?? null,
        projectName: r.project_name ?? null,
        workflowId: r.workflow_id ?? null,
        taskStatus: r.task_status ?? null,
        finalStatus: r.final_status ?? null,
        totals: toTotals(r),
        models,
        agents,
        retries: r.retries ?? 0,
        firstAt: r.first_at,
        lastAt: r.last_at,
      };
    });
  }

  private taskAggregate(f: Partial<UsageFilter>): { sql: string; params: unknown[] } {
    const units = eventUnits(whereClause(f), "''");
    return {
      sql: `SELECT u.task_id, ${TOTALS_COLUMNS}, SUM(u.retry_index > 0) AS retries, MIN(ev.started_at) AS first_at, MAX(ev.started_at) AS last_at,
              tk.title AS task_title, tk.status AS task_status, tk.final_status AS final_status, tk.workflow_id AS workflow_id,
              MIN(ev.project_id) AS project_id, rp.name AS project_name
            FROM (${units.sql}) u JOIN usage_events ev ON ev.id = u.id
            LEFT JOIN tasks tk ON tk.id = u.task_id LEFT JOIN repositories rp ON rp.id = ev.project_id
            WHERE u.task_id IS NOT NULL GROUP BY u.task_id`,
      params: units.params,
    };
  }

  tasks(f: Partial<UsageFilter>, sort: 'cost' | 'tokens' | 'requests' | 'recent', offset: number, limit: number): UsageTaskPage {
    const agg = this.taskAggregate(f);
    const order = { cost: 'cost DESC', tokens: 'total_tokens DESC', requests: 'requests DESC', recent: 'last_at DESC' }[sort];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM (${agg.sql})`).get(...agg.params) as Row).n as number;
    const rows = this.db.prepare(`SELECT * FROM (${agg.sql}) ORDER BY ${order}, task_id DESC LIMIT ? OFFSET ?`).all(...agg.params, limit, offset) as Row[];
    return { items: this.taskRows(rows, f), total, offset };
  }

  /** Per-task cost and outcome only — for task-level KPIs over a whole range. */
  taskOutcomes(f: Partial<UsageFilter>): Array<{ taskId: string; costNanos: number; unknown: number; status: string | null }> {
    const where = whereClause(f);
    return (
      this.db
        .prepare(
          `SELECT e.task_id, COALESCE(SUM(e.display_cost_nanos), 0) AS cost, SUM(e.display_cost_nanos IS NULL) AS unknown, MIN(t.status) AS status
           FROM ${FROM} ${where.sql ? `${where.sql} AND` : 'WHERE'} e.task_id IS NOT NULL GROUP BY e.task_id`,
        )
        .all(...where.params) as Row[]
    ).map((r) => ({ taskId: r.task_id, costNanos: r.cost, unknown: r.unknown, status: r.status }));
  }

  task(taskId: string): UsageTaskRow | null {
    const agg = this.taskAggregate({ taskId });
    const row = this.db.prepare(agg.sql).get(...agg.params) as Row | undefined;
    return row ? this.taskRows([row], { taskId })[0]! : null;
  }

  /** Server-side pagination, newest first, keyset cursor on (started_at, id). */
  events(f: Partial<UsageFilter>, cursor: string | undefined, limit: number): UsageEventPage {
    const where = whereClause(f);
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${FROM} ${where.sql}`).get(...where.params) as Row).n as number;
    let sql = where.sql;
    const params = [...where.params];
    if (cursor) {
      const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
      if (at && id) {
        sql = `${sql ? `${sql} AND` : 'WHERE'} (e.started_at < ? OR (e.started_at = ? AND e.id < ?))`;
        params.push(at, at, id);
      }
    }
    const rows = this.db
      .prepare(`SELECT e.*, r.name AS project_name, t.title AS task_title FROM ${FROM} ${sql} ORDER BY e.started_at DESC, e.id DESC LIMIT ?`)
      .all(...params, limit + 1) as Row[];
    const items = rows.slice(0, limit).map(toUsageEvent);
    const last = items.at(-1);
    return { items, total, nextCursor: rows.length > limit && last ? Buffer.from(`${last.startedAt}|${last.id}`, 'utf8').toString('base64url') : null };
  }

  /** All attempts of one task, oldest first. */
  taskEvents(taskId: string): UsageEvent[] {
    return (this.db.prepare(`SELECT e.*, r.name AS project_name, t.title AS task_title FROM ${FROM} WHERE e.task_id = ? ORDER BY e.started_at, e.created_at`).all(taskId) as Row[]).map(
      toUsageEvent,
    );
  }

  /** Cost per stage run in workflow order, then Chairman and other runs. */
  flow(taskId: string, events: UsageEvent[]): UsageStageCost[] {
    const stages = this.store.listStages(taskId);
    const byRun = new Map<string, UsageEvent[]>();
    const other = new Map<string, UsageEvent[]>();
    for (const e of events) {
      if (e.runId) byRun.set(e.runId, [...(byRun.get(e.runId) ?? []), e]);
      else other.set(e.workflowStep ?? e.origin, [...(other.get(e.workflowStep ?? e.origin) ?? []), e]);
    }
    const sum = (list: UsageEvent[]): UsageTotals => {
      const t = { ...EMPTY_TOTALS };
      for (const e of list) {
        t.requests += 1;
        if (e.status === 'succeeded') t.succeeded += 1;
        else t.failed += 1;
        if (e.displayCostNanos === null) t.unknownCostRequests += 1;
        else {
          t.costNanos += e.displayCostNanos;
          if (e.costSource === 'PROVIDER') t.providerCostRequests += 1;
          else t.calculatedCostRequests += 1;
          if (e.status !== 'succeeded') t.failedCostNanos += e.displayCostNanos;
          if (e.retryIndex > 0) t.retryCostNanos += e.displayCostNanos;
        }
        if (e.retryIndex > 0) t.retryRequests += 1;
        t.inputTokens += e.tokens.input ?? 0;
        t.outputTokens += e.tokens.output ?? 0;
        t.cacheReadTokens += e.tokens.cacheRead ?? 0;
        t.cacheWriteTokens += e.tokens.cacheWrite ?? 0;
        t.reasoningTokens += e.tokens.reasoning ?? 0;
        t.totalTokens += e.tokens.total ?? 0;
        if (e.tokens.total === null) t.unreportedTokenRequests += 1;
        t.durationMs += e.durationMs;
      }
      return t;
    };
    const models = (list: UsageEvent[]) => [...new Set(list.map((e) => e.providerModelId ?? e.model))];
    const rows: UsageStageCost[] = [];
    for (const stage of stages) {
      const list = byRun.get(stage.id);
      if (!list) continue;
      byRun.delete(stage.id);
      rows.push({
        runId: stage.id,
        stageKey: stage.stageKey,
        stageName: stage.name,
        role: stage.role,
        agentId: stage.agentId,
        models: models(list),
        attempts: list.length,
        status: stage.status,
        totals: sum(list),
      });
    }
    // Runs whose stage row is gone, and runs outside a stage (Chairman), keep their cost visible.
    for (const [runId, list] of byRun) {
      rows.push({ runId, stageKey: list[0]!.workflowStep ?? 'stage', stageName: list[0]!.workflowStep ?? 'Stage', role: list[0]!.agentRole, agentId: list[0]!.agentId, models: models(list), attempts: list.length, status: null, totals: sum(list) });
    }
    for (const [step, list] of other) {
      rows.push({
        runId: null,
        stageKey: step,
        stageName: step === 'chairman' ? 'Chairman' : step === 'commit-message' ? 'Commit message' : step,
        role: list[0]!.agentRole,
        agentId: list[0]!.agentId,
        models: models(list),
        attempts: list.length,
        status: null,
        totals: sum(list),
      });
    }
    return rows;
  }
}
