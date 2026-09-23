import path from 'node:path';
import type { ProviderUsageCapabilities } from '@acc/agent-sdk';
import {
  NANOS_PER_USD,
  type BudgetStatus,
  type CapacityReading,
  type HealthCheck,
  type PricingInput,
  type PricingVersion,
  type ProviderSummary,
  type RecalculationResult,
  type ReconciliationResult,
  type UsageAnomaly,
  type UsageBreakdownRow,
  type UsageBilling,
  type UsageEventDetail,
  type UsageEventPage,
  type UsageFilter,
  type UsageHealth,
  type UsageLiveMeter,
  type UsageOverview,
  type UsageTaskLedger,
  type UsageTaskPage,
  type UsageTotals,
} from '@acc/shared';
import type { Bus } from '../bus.js';
import type { Db } from '../db/database.js';
import type { Store } from '../store/store.js';
import { AnomalyDetector } from './anomalies.js';
import { BudgetService, periodWindow } from './budgets.js';
import { CapacityStore } from './capacity.js';
import { UsageLedger } from './ledger.js';
import { PricingRegistry } from './pricing.js';
import { UsageQueries, type BreakdownDimension } from './queries.js';
import { UsageRecorder } from './recorder.js';

type Row = Record<string, any>;

export interface AdapterInfo {
  id: string;
  displayName: string;
  usageCapabilities: ProviderUsageCapabilities;
}

/** Share of provider-reported cost a calculated price may differ by before reconciliation flags it. */
const PRICE_TOLERANCE = 0.02;

const CSV_FORMULA = /^[=+\-@\t\r]/;

/** RFC 4180 cell, with spreadsheet formula injection neutralised. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (CSV_FORMULA.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]!);
  return [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\r\n') + '\r\n';
}

const usd = (nanos: number | null): string | null => (nanos === null ? null : (nanos / NANOS_PER_USD).toFixed(9));

/**
 * Usage, cost and capacity (docs/systems/usage.md): the ledger, pricing,
 * capacity, budgets, anomaly rules and the read models the dashboard uses.
 */
export class UsageService {
  readonly pricing: PricingRegistry;
  readonly ledger: UsageLedger;
  readonly capacity: CapacityStore;
  readonly queries: UsageQueries;
  readonly budgets: BudgetService;
  readonly anomalies: AnomalyDetector;
  readonly recorder: UsageRecorder;
  private adapters: () => AdapterInfo[] = () => [];
  private lastReconciliation: ReconciliationResult | null = null;

  constructor(
    private readonly d: { db: Db; store: Store; bus: Bus; dataDir: string; simulated: boolean },
  ) {
    this.pricing = new PricingRegistry(d.db);
    this.ledger = new UsageLedger(d.db, this.pricing);
    this.capacity = new CapacityStore(d.db);
    this.queries = new UsageQueries(d.db, d.store);
    this.budgets = new BudgetService(d.db, d.store, this.queries);
    this.anomalies = new AnomalyDetector(d.db, this.pricing);
    this.recorder = new UsageRecorder({ ledger: this.ledger, capacity: this.capacity, budgets: this.budgets, bus: d.bus, spoolFile: path.join(d.dataDir, 'usage-spool.jsonl') });
  }

  /** The registered agents, for provider capabilities. Set once the registry exists. */
  attachAdapters(list: () => AdapterInfo[]): void {
    this.adapters = list;
  }

  /** Startup: replay spooled writes, close interrupted attempts, prune old readings, reconcile. */
  recover(): { replayed: number; interrupted: number } {
    const result = this.recorder.recover();
    try {
      this.capacity.prune();
      this.reconcile();
    } catch (error) {
      console.warn(`[usage] startup checks failed: ${(error as Error).message}`);
    }
    return result;
  }

  close(): void {
    this.recorder.stop();
  }

  // ----- read models ----------------------------------------------------------

  private successfulTaskStats(f: Partial<UsageFilter>): { successful: number; failed: number; costPerSuccess: number | null; averageTaskCost: number | null } {
    const tasks = this.queries.taskOutcomes(f);
    const successful = tasks.filter((t) => t.status === 'COMPLETED');
    const failed = tasks.filter((t) => t.status === 'FAILED' || t.status === 'CANCELLED');
    const known = tasks.filter((t) => t.unknown === 0);
    return {
      successful: successful.length,
      failed: failed.length,
      costPerSuccess: successful.length ? Math.round(successful.reduce((s, t) => s + t.costNanos, 0) / successful.length) : null,
      averageTaskCost: known.length ? Math.round(known.reduce((s, t) => s + t.costNanos, 0) / known.length) : null,
    };
  }

  private billingKinds(f: Partial<UsageFilter>): UsageBilling[] {
    return (
      this.d.db
        .prepare('SELECT DISTINCT billing FROM usage_events WHERE started_at >= ? AND started_at < ?')
        .all(f.from ?? '', f.to ?? '9999') as Row[]
    ).map((r) => r.billing as UsageBilling);
  }

  billingNote(kinds: UsageBilling[]): string {
    const parts: string[] = [];
    if (kinds.includes('subscription')) {
      parts.push('Runs on a subscription are not billed per request: their cost is what the same usage would cost at API list prices (Claude Code reports this figure itself), useful for comparison and for pacing the subscription limits.');
    }
    if (kinds.includes('api')) parts.push('Runs on API billing are charged at these prices.');
    if (kinds.includes('simulated')) parts.push('Simulated agents contact no provider; their usage and cost are test figures.');
    return parts.join(' ') || 'No agent runs recorded in this period yet.';
  }

  overview(f: UsageFilter): UsageOverview {
    const now = new Date();
    const providers = this.queries.breakdown(f, 'provider');
    const today = periodWindow('day', now)!;
    const month = periodWindow('month', now)!;
    const stats = this.successfulTaskStats(f);
    const kinds = this.billingKinds(f);
    return {
      range: { from: f.from, to: f.to },
      trackingStartedAt: this.ledger.trackingStartedAt(),
      totals: this.queries.totals(f),
      today: this.queries.totals({ from: today.start.toISOString(), to: today.end.toISOString() }),
      month: this.queries.totals({ from: month.start.toISOString(), to: month.end.toISOString() }),
      costPerSuccessfulTaskNanos: stats.costPerSuccess,
      successfulTasks: stats.successful,
      failedTasks: stats.failed,
      averageTaskCostNanos: stats.averageTaskCost,
      trend: this.queries.trend(f),
      providers,
      models: this.queries.breakdown(f, 'model').slice(0, 8),
      topTasks: this.queries.tasks(f, 'cost', 0, 5).items,
      anomalies: this.anomalies.detect(f).slice(0, 8),
      capacity: this.providers(f, providers),
      budgets: this.budgets.statuses(now),
      health: this.healthChecks(),
      billingNote: this.billingNote(kinds),
      simulated: this.d.simulated || kinds.includes('simulated'),
    };
  }

  trend(f: UsageFilter) {
    return this.queries.trend(f);
  }

  breakdown(f: UsageFilter, dimension: BreakdownDimension) {
    return this.queries.breakdown(f, dimension);
  }

  tasks(f: UsageFilter, sort: 'cost' | 'tokens' | 'requests' | 'recent', offset: number, limit: number): UsageTaskPage {
    return this.queries.tasks(f, sort, offset, limit);
  }

  events(f: UsageFilter, cursor: string | undefined, limit: number): UsageEventPage {
    return this.queries.events(f, cursor, limit);
  }

  event(id: string): UsageEventDetail | null {
    return this.ledger.detail(id);
  }

  anomalyList(f: Partial<UsageFilter>): UsageAnomaly[] {
    return this.anomalies.detect(f);
  }

  taskLedger(taskId: string): UsageTaskLedger | null {
    const task = this.queries.task(taskId);
    const record = this.d.store.getTask(taskId);
    if (!task && !record) return null;
    const events = this.queries.taskEvents(taskId);
    const flow = this.queries.flow(taskId, events);
    const eventTotal = events.reduce((s, e) => s + (e.displayCostNanos ?? 0), 0);
    const flowTotal = flow.reduce((s, r) => s + r.totals.costNanos, 0);
    const row = task ?? {
      taskId,
      taskTitle: record!.title,
      projectId: record!.repositoryId,
      projectName: this.d.store.getRepository(record!.repositoryId)?.name ?? null,
      workflowId: record!.workflowId,
      taskStatus: record!.status,
      finalStatus: record!.finalStatus ?? null,
      totals: this.queries.totals({ taskId }),
      models: [],
      agents: [],
      retries: 0,
      firstAt: record!.createdAt,
      lastAt: record!.updatedAt,
    };
    return {
      task: row,
      live: record ? ['RUNNING', 'QUEUED'].includes(record.status) : false,
      flow,
      events,
      budgets: this.budgets.forTask(taskId, row.projectId),
      anomalies: this.anomalies.detect({ taskId }),
      reconciliation: { eventTotalNanos: eventTotal, flowTotalNanos: flowTotal, matches: eventTotal === flowTotal },
    };
  }

  live(taskId: string): UsageLiveMeter {
    const record = this.d.store.getTask(taskId);
    const totals = this.queries.totals({ taskId });
    const stage = record?.currentStageId ? this.d.store.getStage(record.currentStageId) : null;
    const retries = (this.d.db.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE task_id = ? AND retry_index > 0').get(taskId) as Row).n as number;
    return {
      taskId,
      totals,
      retries,
      currentAgentId: stage?.agentId ?? null,
      currentStage: stage?.name ?? null,
      budgets: this.budgets.forTask(taskId, record?.repositoryId ?? null),
    };
  }

  providers(f: Partial<UsageFilter>, computed?: UsageBreakdownRow[]): ProviderSummary[] {
    const readings = this.capacity.readings();
    const adapters = this.adapters();
    const breakdown = computed ?? this.queries.breakdown(f, 'provider');
    const names = new Set([...adapters.map((a) => a.usageCapabilities.provider), ...breakdown.map((b) => b.key)]);
    return [...names].sort().map((provider) => {
      const agents = adapters.filter((a) => a.usageCapabilities.provider === provider);
      const agentIds = [...new Set([...agents.map((a) => a.id), ...(this.d.db.prepare('SELECT DISTINCT agent_id FROM usage_events WHERE provider = ?').all(provider) as Row[]).map((r) => r.agent_id as string)])];
      const capacity: CapacityReading[] = readings.filter((r) => r.provider === provider);
      const limited = this.d.db
        .prepare("SELECT COUNT(*) AS n FROM usage_events WHERE provider = ? AND error_class = 'USAGE_LIMIT' AND started_at >= ? AND started_at < ?")
        .get(provider, f.from ?? '', f.to ?? '9999') as Row;
      const billing = (this.d.db.prepare('SELECT DISTINCT billing FROM usage_events WHERE provider = ?').all(provider) as Row[]).map((r) => r.billing as UsageBilling);
      return {
        provider,
        agentIds,
        billing,
        totals: breakdown.find((b) => b.key === provider)?.totals ?? this.queries.totals({ ...f, provider }),
        usageLimitEvents: limited.n as number,
        capabilities: agents[0]?.usageCapabilities ?? null,
        capacity,
        lastCapacityAt: capacity.map((c) => c.capturedAt).sort().at(-1) ?? null,
      };
    });
  }

  /** "Refresh" re-reads stored readings and judges freshness; providers expose no separate limits endpoint. */
  refreshCapacity(): ProviderSummary[] {
    this.capacity.prune();
    return this.providers({});
  }

  // ----- pricing ----------------------------------------------------------------

  listPricing(): PricingVersion[] {
    return this.pricing.list();
  }

  addPricing(input: PricingInput): PricingVersion {
    return this.pricing.add(input);
  }

  recalculate(reason: string): RecalculationResult {
    const result = this.ledger.recalculateUnknown(reason);
    for (const event of result.events) this.d.bus.publish({ type: 'usage', event });
    return { examined: result.examined, recalculated: result.recalculated, stillUnknown: result.examined - result.recalculated };
  }

  // ----- reconciliation and health -------------------------------------------

  /** Every total the dashboard shows must equal the sum of the raw attempts behind it. */
  reconcile(): ReconciliationResult {
    const all: Partial<UsageFilter> = {};
    const total = this.queries.totals(all);
    const sum = (rows: Array<{ totals: UsageTotals }>, pick: (t: UsageTotals) => number) => rows.reduce((s, r) => s + pick(r.totals), 0);
    const providers = this.queries.breakdown(all, 'provider');
    const models = this.queries.breakdown(all, 'model');
    const days = this.queries.trend(all);
    const taskCost = (this.d.db.prepare('SELECT COALESCE(SUM(c), 0) AS c FROM (SELECT SUM(display_cost_nanos) AS c FROM usage_events WHERE task_id IS NOT NULL GROUP BY task_id)').get() as Row).c as number;
    const unattributed = (this.d.db.prepare('SELECT COALESCE(SUM(display_cost_nanos), 0) AS c FROM usage_events WHERE task_id IS NULL').get() as Row).c as number;
    const lineMismatch = (
      this.d.db
        .prepare(
          `SELECT COUNT(*) AS n FROM usage_events e JOIN (
             SELECT event_id, SUM(COALESCE(input_tokens, 0)) AS i, SUM(COALESCE(output_tokens, 0)) AS o,
                    SUM(COALESCE(provider_cost_nanos, calculated_cost_nanos)) AS c, SUM(COALESCE(provider_cost_nanos, calculated_cost_nanos) IS NULL) AS u
             FROM usage_event_lines GROUP BY event_id) l ON l.event_id = e.id
           WHERE COALESCE(e.input_tokens, 0) <> l.i OR COALESCE(e.output_tokens, 0) <> l.o
              OR (e.display_cost_nanos IS NOT NULL AND (l.u > 0 OR e.display_cost_nanos <> l.c))`,
        )
        .get() as Row
    ).n as number;
    const priceDrift = (
      this.d.db
        .prepare(
          `SELECT COUNT(*) AS n FROM usage_event_lines WHERE provider_cost_nanos > 0 AND calculated_cost_nanos IS NOT NULL
             AND ABS(provider_cost_nanos - calculated_cost_nanos) > provider_cost_nanos * ?`,
        )
        .get(PRICE_TOLERANCE) as Row
    ).n as number;
    const check = (name: string, expected: number, actual: number, detail: string) => ({ name, ok: expected === actual, expected, actual, detail });
    const checks = [
      check('Provider totals add up to the overall cost', total.costNanos, sum(providers, (t) => t.costNanos), 'Sum of per-provider cost against the sum of all attempts.'),
      check('Model totals add up to the overall cost', total.costNanos, sum(models, (t) => t.costNanos), 'Sum of per-model cost (one line per model an attempt used).'),
      check('Model token totals add up', total.totalTokens, sum(models, (t) => t.totalTokens), 'Tokens per model against tokens per attempt.'),
      check('Task totals and unattributed runs add up', total.costNanos, taskCost + unattributed, 'Per-task sums plus runs outside a task.'),
      check('Daily totals add up', total.costNanos, days.reduce((s, d) => s + d.costNanos, 0), 'Sum of the daily trend.'),
      check('Attempts match their model lines', 0, lineMismatch, 'Attempts whose tokens or cost differ from the sum of their per-model lines.'),
      check(
        'Price list matches provider-reported cost',
        0,
        priceDrift,
        `Model lines where the calculated cost differs from the provider's own figure by more than ${PRICE_TOLERANCE * 100}% — the price list may be out of date.`,
      ),
    ];
    this.lastReconciliation = { ranAt: new Date().toISOString(), ok: checks.every((c) => c.ok), checks };
    return this.lastReconciliation;
  }

  healthChecks(): HealthCheck[] {
    const recorder = this.recorder.health();
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const recent = this.queries.totals({ from: since });
    const unpriced = (
      this.d.db
        .prepare(
          `SELECT DISTINCT e.provider || '/' || l.model AS m FROM usage_event_lines l JOIN usage_events e ON e.id = l.event_id
           WHERE e.started_at >= ? AND l.provider_cost_nanos IS NULL AND l.pricing_version_id IS NULL`,
        )
        .all(since) as Row[]
    ).map((r) => r.m as string);
    const readings = this.capacity.readings();
    const withCapacity = this.adapters().filter((a) => a.usageCapabilities.quota || a.usageCapabilities.rateLimits || a.usageCapabilities.credit);
    const stale = readings.filter((r) => r.stale);
    const recentError = recorder.lastError && Date.now() - Date.parse(recorder.lastError.at) < 3_600_000;
    const reconciliation = this.lastReconciliation;
    return [
      {
        key: 'ingestion',
        label: 'Usage ingestion',
        state: recorder.pendingWrites ? 'degraded' : recentError ? 'partial' : 'healthy',
        detail: recorder.pendingWrites
          ? `${recorder.pendingWrites} attempt${recorder.pendingWrites === 1 ? '' : 's'} waiting to be saved (retrying). ${recorder.lastError?.message ?? ''}`.trim()
          : recentError
            ? `Recovered from an error in the last hour: ${recorder.lastError!.message}`
            : 'Every attempt is recorded when it finishes.',
      },
      {
        key: 'cost',
        label: 'Cost engine',
        state: recent.unknownCostRequests ? 'partial' : 'healthy',
        detail: recent.unknownCostRequests
          ? `${recent.unknownCostRequests} of ${recent.requests} attempts in the last 30 days have an unknown cost (no reported cost and no verified price, or no usage reported).`
          : 'Every attempt in the last 30 days has a known cost.',
      },
      { key: 'aggregates', label: 'Aggregates', state: 'healthy', detail: 'Totals are computed directly from the ledger; there are no stored rollups to rebuild.' },
      {
        key: 'capacity',
        label: 'Capacity readings',
        state: !withCapacity.length ? 'unavailable' : !readings.length ? 'unavailable' : stale.length ? 'partial' : 'healthy',
        detail: !withCapacity.length
          ? 'No installed provider reports limits.'
          : !readings.length
            ? 'No limit readings yet; they arrive with the next agent run.'
            : stale.length
              ? `${stale.length} of ${readings.length} readings are stale; last values are kept and labelled.`
              : 'Latest limit readings are fresh.',
      },
      {
        key: 'pricing',
        label: 'Pricing registry',
        state: unpriced.length ? 'partial' : 'healthy',
        detail: unpriced.length ? `No price for: ${unpriced.slice(0, 5).join(', ')}${unpriced.length > 5 ? '…' : ''}. Their cost stays Unknown until a verified price is added.` : 'Every model used in the last 30 days has a reported cost or a price.',
      },
      {
        key: 'reconciliation',
        label: 'Reconciliation',
        state: !reconciliation ? 'partial' : reconciliation.ok ? 'healthy' : 'degraded',
        detail: !reconciliation
          ? 'Not run yet.'
          : reconciliation.ok
            ? `All ${reconciliation.checks.length} checks passed ${new Date(reconciliation.ranAt).toLocaleString()}.`
            : `Failed: ${reconciliation.checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}.`,
      },
    ];
  }

  health(): UsageHealth {
    const recorder = this.recorder.health();
    return { checks: this.healthChecks(), reconciliation: this.lastReconciliation, pendingWrites: recorder.pendingWrites, lastIngestError: recorder.lastError?.message ?? null };
  }

  // ----- budgets -----------------------------------------------------------------

  budgetStatuses(): BudgetStatus[] {
    return this.budgets.statuses();
  }

  // ----- export ------------------------------------------------------------------

  export(f: UsageFilter, dataset: 'events' | 'tasks' | 'models', format: 'csv' | 'json'): { filename: string; contentType: string; body: string } {
    let rows: Array<Record<string, unknown>>;
    if (dataset === 'events') {
      rows = [];
      let cursor: string | undefined;
      do {
        const page = this.queries.events(f, cursor, 200);
        for (const e of page.items) {
          rows.push({
            id: e.id,
            startedAt: e.startedAt,
            finishedAt: e.finishedAt,
            durationMs: e.durationMs,
            status: e.status,
            errorClass: e.errorClass,
            origin: e.origin,
            provider: e.provider,
            billing: e.billing,
            agentId: e.agentId,
            model: e.model,
            providerModelId: e.providerModelId,
            providerRequestId: e.providerRequestId,
            projectId: e.projectId,
            projectName: e.projectName,
            taskId: e.taskId,
            taskTitle: e.taskTitle,
            runId: e.runId,
            workflowId: e.workflowId,
            workflowStep: e.workflowStep,
            agentRole: e.agentRole,
            effort: e.effort,
            inputTokens: e.tokens.input,
            outputTokens: e.tokens.output,
            cacheReadTokens: e.tokens.cacheRead,
            cacheWriteTokens: e.tokens.cacheWrite,
            reasoningTokens: e.tokens.reasoning,
            totalTokens: e.tokens.total,
            costSource: e.costSource,
            costUsd: usd(e.displayCostNanos),
            providerCostUsd: usd(e.providerCostNanos),
            calculatedCostUsd: usd(e.calculatedCostNanos),
            pricingVersionId: e.pricingVersionId,
            retryIndex: e.retryIndex,
            attemptReason: e.attemptReason,
            retryParentEventId: e.retryParentEventId,
            fallbackFromModel: e.fallbackFromModel,
            fallbackToModel: e.fallbackToModel,
          });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor && rows.length < 100_000);
    } else if (dataset === 'tasks') {
      rows = this.queries.tasks(f, 'cost', 0, 100_000).items.map((t) => ({
        taskId: t.taskId,
        taskTitle: t.taskTitle,
        projectName: t.projectName,
        workflowId: t.workflowId,
        taskStatus: t.taskStatus,
        requests: t.totals.requests,
        failedRequests: t.totals.failed,
        retries: t.retries,
        totalTokens: t.totals.totalTokens,
        costUsd: usd(t.totals.costNanos),
        unknownCostRequests: t.totals.unknownCostRequests,
        models: t.models.join(' '),
        agents: t.agents.join(' '),
        firstAt: t.firstAt,
        lastAt: t.lastAt,
      }));
    } else {
      rows = this.queries.breakdown(f, 'model').map((m) => ({
        model: m.key,
        provider: m.extra?.provider ?? null,
        requests: m.totals.requests,
        tasks: m.tasks,
        failedRequests: m.totals.failed,
        inputTokens: m.totals.inputTokens,
        outputTokens: m.totals.outputTokens,
        cacheReadTokens: m.totals.cacheReadTokens,
        cacheWriteTokens: m.totals.cacheWriteTokens,
        reasoningTokens: m.totals.reasoningTokens,
        costUsd: usd(m.totals.costNanos),
        unknownCostRequests: m.totals.unknownCostRequests,
        medianTaskCostUsd: usd(m.medianTaskCostNanos),
        costPerSuccessfulTaskUsd: usd(m.costPerSuccessfulTaskNanos),
        retryRate: m.retryRate,
        failureRate: m.failureRate,
        medianLatencyMs: m.medianLatencyMs,
      }));
    }
    const stamp = f.from.slice(0, 10) + '_' + f.to.slice(0, 10);
    return format === 'json'
      ? { filename: `usage-${dataset}-${stamp}.json`, contentType: 'application/json; charset=utf-8', body: JSON.stringify({ range: { from: f.from, to: f.to }, dataset, rows }, null, 2) }
      : { filename: `usage-${dataset}-${stamp}.csv`, contentType: 'text/csv; charset=utf-8', body: toCsv(rows) };
  }
}
