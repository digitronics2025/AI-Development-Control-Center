import { randomUUID } from 'node:crypto';
import type { AgentUsageReport } from '@acc/agent-sdk';
import type {
  AttemptReason,
  CostRevision,
  CostSource,
  UsageBilling,
  UsageEvent,
  UsageEventDetail,
  UsageEventLine,
  UsageEventStatus,
  UsageOrigin,
} from '@acc/shared';
import type { Db } from '../db/database.js';
import { calculateLineCost, resolveEventCost, sumTokens, usdToNanos, type CostedLine } from './cost.js';
import type { PricingRegistry } from './pricing.js';

/** Where an attempt belongs. Values that do not apply stay null — never invented. */
export interface UsageAttribution {
  origin: UsageOrigin;
  projectId: string | null;
  taskId: string | null;
  /** Stage instance id: one per stage attempt. */
  runId: string | null;
  workflowId: string | null;
  /** Stage key, or `chairman` / `commit-message` outside a workflow stage. */
  workflowStep: string | null;
  agentRole: string | null;
  mode: string | null;
}

/** Everything known when an attempt is dispatched. Written to `usage_pending` until it finishes. */
export interface UsageDispatch {
  /** The execution id: the attempt's idempotency key. */
  key: string;
  agentId: string;
  provider: string;
  billing: UsageBilling;
  model: string;
  effort: string | null;
  promptChars: number;
  promptHash: string;
  startedAt: string;
  attribution: UsageAttribution;
}

export interface UsageCompletion {
  finishedAt: string;
  durationMs: number;
  status: UsageEventStatus;
  errorClass: string | null;
  usage: AgentUsageReport | null;
}

type Row = Record<string, any>;

const EVENT_SELECT = `SELECT e.*, r.name AS project_name, t.title AS task_title
  FROM usage_events e
  LEFT JOIN repositories r ON r.id = e.project_id
  LEFT JOIN tasks t ON t.id = e.task_id`;

export function toUsageEvent(r: Row): UsageEvent {
  return {
    id: r.id,
    executionId: r.idempotency_key,
    origin: r.origin,
    provider: r.provider,
    billing: r.billing,
    agentId: r.agent_id,
    model: r.model,
    providerModelId: r.provider_model_id,
    providerRequestId: r.provider_request_id,
    projectId: r.project_id,
    projectName: r.project_name ?? null,
    taskId: r.task_id,
    taskTitle: r.task_title ?? null,
    runId: r.run_id,
    workflowId: r.workflow_id,
    workflowStep: r.workflow_step,
    agentRole: r.agent_role,
    mode: r.mode,
    effort: r.effort,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    apiDurationMs: r.api_duration_ms,
    turns: r.turns,
    tokens: {
      input: r.input_tokens,
      output: r.output_tokens,
      cacheRead: r.cache_read_tokens,
      cacheWrite: r.cache_write_tokens,
      reasoning: r.reasoning_tokens,
      total: r.total_tokens,
    },
    retryIndex: r.retry_index,
    retryParentEventId: r.retry_parent_event_id,
    attemptReason: r.attempt_reason,
    fallbackFromModel: r.fallback_from_model,
    fallbackToModel: r.fallback_to_model,
    providerCostNanos: r.provider_cost_nanos,
    calculatedCostNanos: r.calculated_cost_nanos,
    displayCostNanos: r.display_cost_nanos,
    currency: 'USD',
    costSource: r.cost_source,
    pricingVersionId: r.pricing_version_id,
    status: r.status,
    errorClass: r.error_class,
    promptChars: r.prompt_chars,
    promptHash: r.prompt_hash,
    createdAt: r.created_at,
  };
}

function toLine(r: Row): UsageEventLine {
  const parts = [r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens].filter((v): v is number => v !== null);
  return {
    model: r.model,
    tokens: {
      input: r.input_tokens,
      output: r.output_tokens,
      cacheRead: r.cache_read_tokens,
      cacheWrite: r.cache_write_tokens,
      reasoning: r.reasoning_tokens,
      total: parts.length ? parts.reduce((a, b) => a + b, 0) : null,
    },
    cacheWrite1h: r.cache_write_1h_tokens,
    providerCostNanos: r.provider_cost_nanos,
    calculatedCostNanos: r.calculated_cost_nanos,
    pricingVersionId: r.pricing_version_id,
  };
}

/** The model an attempt actually ran, for comparisons and display. */
function effectiveModel(row: Row): string {
  return row.provider_model_id ?? row.model;
}

/**
 * The immutable usage ledger (docs/systems/usage.md#ledger). One row per
 * provider attempt, keyed by its execution id so a replayed or duplicated
 * write is a no-op. Stage attempts are linked to the previous attempt of the
 * same stage in the same task.
 */
export class UsageLedger {
  constructor(
    private readonly db: Db,
    private readonly pricing: PricingRegistry,
  ) {}

  markPending(dispatch: UsageDispatch): void {
    this.db.prepare('INSERT OR IGNORE INTO usage_pending (idempotency_key, payload_json, started_at) VALUES (?, ?, ?)').run(dispatch.key, JSON.stringify(dispatch), dispatch.startedAt);
  }

  listPending(): UsageDispatch[] {
    return (this.db.prepare('SELECT payload_json FROM usage_pending ORDER BY started_at').all() as Row[]).flatMap((r) => {
      try {
        return [JSON.parse(r.payload_json) as UsageDispatch];
      } catch {
        return [];
      }
    });
  }

  clearPending(key: string): void {
    this.db.prepare('DELETE FROM usage_pending WHERE idempotency_key = ?').run(key);
  }

  has(key: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM usage_events WHERE idempotency_key = ?').get(key));
  }

  private lineage(dispatch: UsageDispatch): { retryIndex: number; parentId: string | null; reason: AttemptReason; from: string | null; to: string | null } {
    const a = dispatch.attribution;
    if (a.origin !== 'stage' || !a.taskId || !a.workflowStep) return { retryIndex: 0, parentId: null, reason: 'initial', from: null, to: null };
    const previous = this.db
      .prepare(
        `SELECT id, agent_id, model, provider_model_id, status, (SELECT COUNT(*) FROM usage_events p WHERE p.task_id = ? AND p.workflow_step = ? AND p.origin = 'stage' AND p.started_at <= ?) AS n
         FROM usage_events WHERE task_id = ? AND workflow_step = ? AND origin = 'stage' AND started_at <= ?
         ORDER BY started_at DESC, created_at DESC LIMIT 1`,
      )
      .get(a.taskId, a.workflowStep, dispatch.startedAt, a.taskId, a.workflowStep, dispatch.startedAt) as Row | undefined;
    if (!previous) return { retryIndex: 0, parentId: null, reason: 'initial', from: null, to: null };
    const switched = previous.agent_id !== dispatch.agentId || previous.model !== dispatch.model;
    if (switched) return { retryIndex: previous.n, parentId: previous.id, reason: 'reroute', from: `${previous.agent_id}/${effectiveModel(previous)}`, to: `${dispatch.agentId}/${dispatch.model}` };
    return { retryIndex: previous.n, parentId: previous.id, reason: previous.status === 'succeeded' ? 'rerun' : 'retry', from: null, to: null };
  }

  /** Cost each usage line at the price in force when the attempt started. */
  costLines(provider: string, startedAt: string, usage: AgentUsageReport | null): CostedLine[] {
    return (usage?.lines ?? []).map((line) => {
      const price = this.pricing.lookup(provider, line.model, startedAt);
      return {
        line,
        providerCostNanos: usdToNanos(line.reportedCostUsd),
        calculatedCostNanos: price ? calculateLineCost(line, price) : null,
        pricingVersionId: price?.id ?? null,
      };
    });
  }

  /**
   * Record one finished attempt, its usage lines and the end of its pending
   * marker in one transaction. Returns null when the attempt is already
   * recorded (idempotent replay).
   */
  record(dispatch: UsageDispatch, completion: UsageCompletion): UsageEvent | null {
    const id = randomUUID();
    const inserted = this.db.transaction(() => {
      if (this.has(dispatch.key)) {
        this.clearPending(dispatch.key);
        return false;
      }
      const lineage = this.lineage(dispatch);
      const lines = this.costLines(dispatch.provider, dispatch.startedAt, completion.usage);
      const cost = resolveEventCost(lines);
      const tokens = sumTokens(lines.map((l) => l.line));
      const a = dispatch.attribution;
      this.db
        .prepare(
          `INSERT INTO usage_events (id, idempotency_key, origin, provider, billing, agent_id, model, provider_model_id, provider_request_id,
             project_id, task_id, run_id, workflow_id, workflow_step, agent_role, mode, effort,
             started_at, finished_at, duration_ms, api_duration_ms, turns,
             input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
             retry_index, retry_parent_event_id, attempt_reason, fallback_from_model, fallback_to_model,
             provider_cost_nanos, calculated_cost_nanos, display_cost_nanos, cost_source, pricing_version_id,
             status, error_class, prompt_chars, prompt_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          dispatch.key,
          a.origin,
          dispatch.provider,
          dispatch.billing,
          dispatch.agentId,
          dispatch.model,
          completion.usage?.resolvedModel ?? null,
          completion.usage?.providerRequestId ?? null,
          a.projectId,
          a.taskId,
          a.runId,
          a.workflowId,
          a.workflowStep,
          a.agentRole,
          a.mode,
          dispatch.effort,
          dispatch.startedAt,
          completion.finishedAt,
          Math.max(0, Math.round(completion.durationMs)),
          completion.usage?.apiDurationMs ?? null,
          completion.usage?.turns ?? null,
          tokens.input,
          tokens.output,
          tokens.cacheRead,
          tokens.cacheWrite,
          tokens.reasoning,
          tokens.total,
          lineage.retryIndex,
          lineage.parentId,
          lineage.reason,
          lineage.from,
          lineage.to,
          cost.providerCostNanos,
          cost.calculatedCostNanos,
          cost.displayCostNanos,
          cost.costSource,
          cost.pricingVersionId,
          completion.status,
          completion.errorClass,
          dispatch.promptChars,
          dispatch.promptHash,
          new Date().toISOString(),
        );
      const insertLine = this.db.prepare(
        `INSERT INTO usage_event_lines (event_id, line_no, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens,
           reasoning_tokens, provider_cost_nanos, calculated_cost_nanos, pricing_version_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      lines.forEach((l, i) =>
        insertLine.run(
          id,
          i,
          l.line.model,
          l.line.inputTokens,
          l.line.outputTokens,
          l.line.cacheReadTokens,
          l.line.cacheWriteTokens,
          l.line.cacheWrite1hTokens,
          l.line.reasoningTokens,
          l.providerCostNanos,
          l.calculatedCostNanos,
          l.pricingVersionId,
        ),
      );
      this.clearPending(dispatch.key);
      return true;
    })();
    return inserted ? this.get(id) : null;
  }

  get(id: string): UsageEvent | null {
    const row = this.db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(id) as Row | undefined;
    return row ? toUsageEvent(row) : null;
  }

  detail(id: string): UsageEventDetail | null {
    const event = this.get(id);
    if (!event) return null;
    const lines = (this.db.prepare('SELECT * FROM usage_event_lines WHERE event_id = ? ORDER BY line_no').all(id) as Row[]).map(toLine);
    return { ...event, lines, revisions: this.revisions(id) };
  }

  revisions(eventId: string): CostRevision[] {
    return (this.db.prepare('SELECT * FROM usage_cost_revisions WHERE event_id = ? ORDER BY created_at').all(eventId) as Row[]).map((r) => ({
      id: r.id,
      eventId: r.event_id,
      previousSource: r.previous_source,
      newSource: r.new_source,
      calculatedCostNanos: r.calculated_cost_nanos,
      pricingVersionId: r.pricing_version_id,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }

  /**
   * Controlled repair: cost attempts whose cost was Unknown now that a price
   * exists. Tokens are never touched; each change is audited. The database
   * refuses to re-cost an attempt whose cost was already known.
   */
  recalculateUnknown(reason: string): { examined: number; recalculated: number; events: UsageEvent[] } {
    const rows = this.db.prepare("SELECT * FROM usage_events WHERE cost_source = 'UNKNOWN' ORDER BY started_at").all() as Row[];
    const changed: string[] = [];
    for (const row of rows) {
      const lineRows = this.db.prepare('SELECT * FROM usage_event_lines WHERE event_id = ? ORDER BY line_no').all(row.id) as Row[];
      if (!lineRows.length) continue;
      const costed = lineRows.map((l) => {
        const line = {
          model: l.model,
          inputTokens: l.input_tokens,
          outputTokens: l.output_tokens,
          cacheReadTokens: l.cache_read_tokens,
          cacheWriteTokens: l.cache_write_tokens,
          cacheWrite1hTokens: l.cache_write_1h_tokens,
          reasoningTokens: l.reasoning_tokens,
          reportedCostUsd: null,
        };
        const price = this.pricing.lookup(row.provider, l.model, row.started_at);
        return { line, providerCostNanos: l.provider_cost_nanos as number | null, calculatedCostNanos: price ? calculateLineCost(line, price) : null, pricingVersionId: price?.id ?? null };
      });
      const cost = resolveEventCost(costed);
      if (cost.costSource === 'UNKNOWN') continue;
      this.db.transaction(() => {
        const updateLine = this.db.prepare('UPDATE usage_event_lines SET calculated_cost_nanos = ?, pricing_version_id = ? WHERE event_id = ? AND line_no = ?');
        costed.forEach((c, i) => updateLine.run(c.calculatedCostNanos, c.pricingVersionId, row.id, lineRows[i]!.line_no));
        this.db
          .prepare('UPDATE usage_events SET calculated_cost_nanos = ?, display_cost_nanos = ?, cost_source = ?, pricing_version_id = ? WHERE id = ?')
          .run(cost.calculatedCostNanos, cost.displayCostNanos, cost.costSource, cost.pricingVersionId, row.id);
        this.db
          .prepare(
            'INSERT INTO usage_cost_revisions (id, event_id, previous_source, new_source, calculated_cost_nanos, pricing_version_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(randomUUID(), row.id, 'UNKNOWN' satisfies CostSource, cost.costSource, cost.calculatedCostNanos, cost.pricingVersionId, reason, new Date().toISOString());
      })();
      changed.push(row.id);
    }
    return { examined: rows.length, recalculated: changed.length, events: changed.map((id) => this.get(id)!).filter(Boolean) };
  }

  /** When accounting began: the migration that created the ledger. */
  trackingStartedAt(): string | null {
    const row = this.db.prepare('SELECT applied_at FROM schema_migrations WHERE version = 4').get() as Row | undefined;
    return row?.applied_at ?? null;
  }
}
