import { formatUsd, NANOS_PER_USD, type UsageAnomaly, type UsageFilter } from '@acc/shared';
import type { Db } from '../db/database.js';
import type { PricingRegistry } from './pricing.js';

type Row = Record<string, any>;

/**
 * Thresholds of the deterministic waste rules (docs/systems/usage.md#anomalies).
 * Every anomaly states the rule, the threshold and the measured value.
 */
export const ANOMALY_RULES = {
  /** Attempts of one stage in one task. */
  excessiveRetries: 4,
  /** An identical prompt sent again this soon after a successful attempt. */
  duplicateWindowMs: 10 * 60_000,
  /** Context (input + cache) per attempt counted as large, and how many large sends per task are flagged. */
  largeContextTokens: 150_000,
  repeatedContextCount: 3,
  /** Failed-attempt spend per task that raises the severity to warning. */
  failedSpendWarningNanos: 1 * NANOS_PER_USD,
  /** Task cost against the median of the same workflow, and the history it needs. */
  abnormalTaskCostFactor: 3,
  abnormalTaskCostMinHistory: 5,
  historyDays: 90,
  /** Growth between consecutive attempts of one stage. */
  tokenGrowthFactor: 2,
  tokenGrowthMinTokens: 50_000,
  /** Input-price ratio of a reroute that counts as an escalation. */
  escalationPriceFactor: 1.5,
  /** Fixer attempts in one task. */
  reviewFixLoop: 3,
} as const;

const R = ANOMALY_RULES;

function range(f: Partial<UsageFilter>, alias = 'e'): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const conditions: Array<[string, unknown]> = [
    [`${alias}.started_at >= ?`, f.from],
    [`${alias}.started_at < ?`, f.to],
    [`${alias}.task_id = ?`, f.taskId],
    [`${alias}.project_id = ?`, f.projectId],
    [`${alias}.provider = ?`, f.provider],
    [`${alias}.agent_id = ?`, f.agentId],
  ];
  for (const [sql, value] of conditions) {
    if (value === undefined || value === '') continue;
    clauses.push(sql);
    params.push(value);
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '1 = 1', params };
}

const ids = (text: string | null): string[] => (text ? text.split(',') : []);
const tokensOf = (r: Row) => (r.input_tokens ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_write_tokens ?? 0);

/** Deterministic, explainable waste detection over the ledger. No scores, no models. */
export class AnomalyDetector {
  constructor(
    private readonly db: Db,
    private readonly pricing: PricingRegistry,
  ) {}

  detect(f: Partial<UsageFilter>): UsageAnomaly[] {
    const now = new Date().toISOString();
    const found: UsageAnomaly[] = [
      ...this.excessiveRetries(f),
      ...this.duplicates(f),
      ...this.repeatedContext(f),
      ...this.failedSpend(f),
      ...this.abnormalTaskCost(f),
      ...this.tokenGrowth(f),
      ...this.escalations(f),
      ...this.fixLoops(f),
    ].map((a) => ({ ...a, detectedAt: now }));
    const weight = { critical: 0, warning: 1, info: 2 };
    return found.sort((a, b) => weight[a.severity] - weight[b.severity] || (b.costNanos ?? 0) - (a.costNanos ?? 0));
  }

  private excessiveRetries(f: Partial<UsageFilter>): Omit<UsageAnomaly, 'detectedAt'>[] {
    const w = range(f);
    const rows = this.db
      .prepare(
        `SELECT e.task_id, e.workflow_step, COUNT(*) AS n, SUM(e.display_cost_nanos) AS cost, GROUP_CONCAT(e.id) AS ids
         FROM usage_events e WHERE ${w.sql} AND e.origin = 'stage' AND e.task_id IS NOT NULL
         GROUP BY e.task_id, e.workflow_step HAVING n >= ?`,
      )
      .all(...w.params, R.excessiveRetries) as Row[];
    return rows.map((r) => ({
      id: `excessive_retries:${r.task_id}:${r.workflow_step}`,
      kind: 'excessive_retries',
      severity: r.n >= R.excessiveRetries * 2 ? 'critical' : 'warning',
      title: `${r.task_id}: stage "${r.workflow_step}" ran ${r.n} times`,
      explanation: `Rule: ${R.excessiveRetries} or more attempts of one stage in one task. Measured: ${r.n} attempts costing ${formatUsd(r.cost)}.`,
      taskId: r.task_id,
      runId: null,
      eventIds: ids(r.ids),
      costNanos: r.cost,
    }));
  }

  private duplicates(f: Partial<UsageFilter>): Omit<UsageAnomaly, 'detectedAt'>[] {
    const w = range(f, 'b');
    const rows = this.db
      .prepare(
        `SELECT b.id, b.task_id, b.run_id, b.display_cost_nanos AS cost, a.id AS first_id, b.agent_id, b.model,
                CAST((julianday(b.started_at) - julianday(a.finished_at)) * 86400 AS INTEGER) AS gap
         FROM usage_events b JOIN usage_events a
           ON a.prompt_hash = b.prompt_hash AND a.agent_id = b.agent_id AND a.model = b.model AND a.id <> b.id
          AND a.status = 'succeeded' AND a.finished_at <= b.started_at
          AND (julianday(b.started_at) - julianday(a.finished_at)) * 86400000 <= ?
         WHERE ${w.sql} AND b.prompt_hash IS NOT NULL
         GROUP BY b.id`,
      )
      .all(R.duplicateWindowMs, ...w.params) as Row[];
    return rows.map((r) => ({
      id: `duplicate_call:${r.id}`,
      kind: 'duplicate_call',
      severity: 'warning',
      title: `${r.task_id ?? 'A run'}: identical request sent again`,
      explanation: `Rule: the same prompt sent to the same agent and model within ${R.duplicateWindowMs / 60_000} minutes of a successful attempt. Measured: resent ${r.gap} s later (${r.agent_id}/${r.model}), costing ${formatUsd(r.cost)}.`,
      taskId: r.task_id,
      runId: r.run_id,
      eventIds: [r.first_id, r.id],
      costNanos: r.cost,
    }));
  }

  private repeatedContext(f: Partial<UsageFilter>): Omit<UsageAnomaly, 'detectedAt'>[] {
    const w = range(f);
    const rows = this.db
      .prepare(
        `SELECT e.task_id, COUNT(*) AS n, SUM(e.display_cost_nanos) AS cost, GROUP_CONCAT(e.id) AS ids,
                SUM(COALESCE(e.input_tokens, 0) + COALESCE(e.cache_read_tokens, 0) + COALESCE(e.cache_write_tokens, 0)) AS context
         FROM usage_events e WHERE ${w.sql} AND e.task_id IS NOT NULL
           AND COALESCE(e.input_tokens, 0) + COALESCE(e.cache_read_tokens, 0) + COALESCE(e.cache_write_tokens, 0) >= ?
         GROUP BY e.task_id HAVING n >= ?`,
      )
      .all(...w.params, R.largeContextTokens, R.repeatedContextCount) as Row[];
    return rows.map((r) => ({
      id: `repeated_context:${r.task_id}`,
      kind: 'repeated_context',
      severity: 'info',
      title: `${r.task_id}: large context sent ${r.n} times`,
      explanation: `Rule: ${R.repeatedContextCount} or more attempts in one task each sending at least ${R.largeContextTokens.toLocaleString('en-US')} context tokens (input and cache). Measured: ${r.n} attempts, ${Number(r.context).toLocaleString('en-US')} context tokens in total. Turning off "Load my CLI customisations" for an agent reduces this.`,
      taskId: r.task_id,
      runId: null,
      eventIds: ids(r.ids),
      costNanos: r.cost,
    }));
  }

  private failedSpend(f: Partial<UsageFilter>): Omit<UsageAnomaly, 'detectedAt'>[] {
    const w = range(f);
    const rows = this.db
      .prepare(
        `SELECT COALESCE(e.task_id, e.agent_id) AS scope, e.task_id, COUNT(*) AS n, SUM(e.display_cost_nanos) AS cost, GROUP_CONCAT(e.id) AS ids
         FROM usage_events e WHERE ${w.sql} AND e.status <> 'succeeded' AND e.display_cost_nanos > 0
         GROUP BY scope`,
      )
      .all(...w.params) as Row[];
    return rows.map((r) => ({
      id: `failed_call_spend:${r.scope}`,
      kind: 'failed_call_spend',
      severity: r.cost >= R.failedSpendWarningNanos ? 'warning' : 'info',
      title: `${r.task_id ?? r.scope}: ${formatUsd(r.cost)} spent on failed attempts`,
      explanation: `Rule: any cost reported for attempts that did not succeed (warning from ${formatUsd(R.failedSpendWarningNanos)}). Measured: ${r.n} failed attempt${r.n === 1 ? '' : 's'} costing ${formatUsd(r.cost)}.`,
      taskId: r.task_id,
      runId: null,
      eventIds: ids(r.ids),
      costNanos: r.cost,
    }));
  }

  private abnormalTaskCost(f: Partial<UsageFilter>): Omit<UsageAnomaly, 'detectedAt'>[] {
    const w = range(f);
    const tasks = this.db
      .prepare(
        `SELECT e.task_id, e.workflow_id, SUM(e.display_cost_nanos) AS cost, SUM(e.display_cost_nanos IS NULL) AS unknown
         FROM usage_events e WHERE ${w.sql} AND e.task_id IS NOT NULL AND e.workflow_id IS NOT NULL GROUP BY e.task_id`,
      )
      .all(...w.params) as Row[];
    const since = new Date(Date.now() - R.historyDays * 86_400_000).toISOString();
    const history = this.db
      .prepare(
        `SELECT e.task_id, e.workflow_id, SUM(e.display_cost_nanos) AS cost FROM usage_events e
         WHERE e.started_at >= ? AND e.task_id IS NOT NULL AND e.workflow_id IS NOT NULL
         GROUP BY e.task_id HAVING SUM(e.display_cost_nanos IS NULL) = 0`,
      )
      .all(since) as Row[];
    const out: Omit<UsageAnomaly, 'detectedAt'>[] = [];
    for (const t of tasks) {
      if (t.unknown || !t.cost) continue;
      const peers = history.filter((h) => h.workflow_id === t.workflow_id && h.task_id !== t.task_id).map((h) => h.cost as number);
      if (peers.length < R.abnormalTaskCostMinHistory) continue;
      const sorted = [...peers].sort((a, b) => a - b);
      const mid = sorted[Math.floor(sorted.length / 2)]!;
      if (mid > 0 && t.cost > mid * R.abnormalTaskCostFactor) {
        out.push({
          id: `abnormal_task_cost:${t.task_id}`,
          kind: 'abnormal_task_cost',
          severity: 'warning',
          title: `${t.task_id} cost ${(t.cost / mid).toFixed(1)}× the usual`,
          explanation: `Rule: a task costing more than ${R.abnormalTaskCostFactor}× the median of ${peers.length} other "${t.workflow_id}" tasks in the last ${R.historyDays} days. Measured: ${formatUsd(t.cost)} against a median of ${formatUsd(mid)}.`,
          taskId: t.task_id,
          runId: null,
          eventIds: [],
          costNanos: t.cost,
        });
      }
    }
    return out;
  }

  private tokenGrowth(f: Partial<UsageFilter>): Omit<UsageAnomaly, 'detectedAt'>[] {
    const w = range(f);
    const rows = this.db
      .prepare(
        `SELECT e.id, e.task_id, e.run_id, e.workflow_step, e.input_tokens, e.cache_read_tokens, e.cache_write_tokens, e.display_cost_nanos
         FROM usage_events e WHERE ${w.sql} AND e.origin = 'stage' AND e.task_id IS NOT NULL AND e.total_tokens IS NOT NULL
         ORDER BY e.task_id, e.workflow_step, e.started_at`,
      )
      .all(...w.params) as Row[];
    const out: Omit<UsageAnomaly, 'detectedAt'>[] = [];
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!;
      const b = rows[i]!;
      if (a.task_id !== b.task_id || a.workflow_step !== b.workflow_step) continue;
      const before = tokensOf(a);
      const after = tokensOf(b);
      if (before > 0 && after >= R.tokenGrowthMinTokens && after >= before * R.tokenGrowthFactor) {
        out.push({
          id: `abnormal_token_growth:${b.id}`,
          kind: 'abnormal_token_growth',
          severity: 'warning',
          title: `${b.task_id}: "${b.workflow_step}" context grew ${(after / before).toFixed(1)}×`,
          explanation: `Rule: an attempt sending at least ${R.tokenGrowthFactor}× the context of the previous attempt of the same stage (and at least ${R.tokenGrowthMinTokens.toLocaleString('en-US')} tokens). Measured: ${before.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} tokens.`,
          taskId: b.task_id,
          runId: b.run_id,
          eventIds: [a.id, b.id],
          costNanos: b.display_cost_nanos,
        });
      }
    }
    return out;
  }

  private escalations(f: Partial<UsageFilter>): Omit<UsageAnomaly, 'detectedAt'>[] {
    const w = range(f);
    const rows = this.db
      .prepare(
        `SELECT e.id, e.task_id, e.run_id, e.provider, e.started_at, COALESCE(e.provider_model_id, e.model) AS to_model, e.display_cost_nanos,
                p.provider AS from_provider, COALESCE(p.provider_model_id, p.model) AS from_model, p.id AS parent_id
         FROM usage_events e JOIN usage_events p ON p.id = e.retry_parent_event_id
         WHERE ${w.sql} AND e.attempt_reason = 'reroute'`,
      )
      .all(...w.params) as Row[];
    const out: Omit<UsageAnomaly, 'detectedAt'>[] = [];
    for (const r of rows) {
      const before = this.pricing.lookup(r.from_provider, r.from_model, r.started_at);
      const after = this.pricing.lookup(r.provider, r.to_model, r.started_at);
      if (!before || !after || before.inputNanos === 0) continue;
      const ratio = after.inputNanos / before.inputNanos;
      if (ratio < R.escalationPriceFactor) continue;
      out.push({
        id: `model_escalation:${r.id}`,
        kind: 'model_escalation',
        severity: 'warning',
        title: `${r.task_id ?? 'A run'}: rerouted to a ${ratio.toFixed(1)}× pricier model`,
        explanation: `Rule: a stage moved to a model whose input price is at least ${R.escalationPriceFactor}× the previous one. Measured: ${r.from_model} → ${r.to_model}, input price ×${ratio.toFixed(2)}.`,
        taskId: r.task_id,
        runId: r.run_id,
        eventIds: [r.parent_id, r.id],
        costNanos: r.display_cost_nanos,
      });
    }
    return out;
  }

  private fixLoops(f: Partial<UsageFilter>): Omit<UsageAnomaly, 'detectedAt'>[] {
    const w = range(f);
    const rows = this.db
      .prepare(
        `SELECT e.task_id, COUNT(*) AS n, SUM(e.display_cost_nanos) AS cost, GROUP_CONCAT(e.id) AS ids
         FROM usage_events e WHERE ${w.sql} AND e.agent_role = 'fixer' AND e.task_id IS NOT NULL
         GROUP BY e.task_id HAVING n >= ?`,
      )
      .all(...w.params, R.reviewFixLoop) as Row[];
    return rows.map((r) => ({
      id: `review_fix_loop:${r.task_id}`,
      kind: 'review_fix_loop',
      severity: 'warning',
      title: `${r.task_id}: ${r.n} fix cycles`,
      explanation: `Rule: ${R.reviewFixLoop} or more fixer attempts in one task (review or tests kept failing). Measured: ${r.n} fixer attempts costing ${formatUsd(r.cost)}.`,
      taskId: r.task_id,
      runId: null,
      eventIds: ids(r.ids),
      costNanos: r.cost,
    }));
  }
}
