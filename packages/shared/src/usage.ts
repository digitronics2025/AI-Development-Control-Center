import { z } from 'zod';

/**
 * Usage, cost and capacity accounting (docs/systems/usage.md).
 *
 * Money travels as integer **nano-dollars** (1 USD = 1,000,000,000): prices
 * per token are whole nano-dollars ($1 per million tokens = 1,000 per token),
 * so every calculated cost is exact integer arithmetic. `null` always means
 * "not known" — it is never shown or summed as zero.
 */

export const NANOS_PER_USD = 1_000_000_000;

/** Where a displayed cost came from, best first. */
export const COST_SOURCES = ['PROVIDER', 'CALCULATED', 'ESTIMATED', 'UNKNOWN'] as const;
export type CostSource = (typeof COST_SOURCES)[number];

/** How far a capacity figure can be trusted. */
export const METRIC_CONFIDENCES = ['LIVE', 'CALCULATED', 'ESTIMATED', 'UNAVAILABLE'] as const;
export type MetricConfidence = (typeof METRIC_CONFIDENCES)[number];

/** Outcome of one provider attempt. `interrupted`: the orchestrator stopped while it ran. */
export const USAGE_EVENT_STATUSES = ['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'] as const;
export type UsageEventStatus = (typeof USAGE_EVENT_STATUSES)[number];

/** What asked for the run. */
export const USAGE_ORIGINS = ['stage', 'chairman', 'source_control', 'ask'] as const;
export type UsageOrigin = (typeof USAGE_ORIGINS)[number];

/**
 * Why an attempt happened: the first run of a stage, an automatic retry
 * after an error, a re-run after a result (fix cycle, recovery) or a run on a
 * different agent/model than the previous attempt.
 */
export const ATTEMPT_REASONS = ['initial', 'retry', 'rerun', 'reroute'] as const;
export type AttemptReason = (typeof ATTEMPT_REASONS)[number];

/** Who pays: a flat subscription, metered API billing, a simulated agent, or unknown. */
export const USAGE_BILLING = ['subscription', 'api', 'simulated', 'unknown'] as const;
export type UsageBilling = (typeof USAGE_BILLING)[number];

export const PRICING_VERIFICATION = ['verified', 'documented', 'unverified'] as const;
export type PricingVerification = (typeof PRICING_VERIFICATION)[number];

export const BUDGET_SCOPES = ['GLOBAL', 'PROVIDER', 'PROJECT', 'MODEL', 'AGENT', 'TASK'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export const BUDGET_PERIODS = ['day', 'week', 'month', 'total'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/**
 * WARN_ONLY shows the state; STOP_NEW_RUNS refuses new agent runs in scope
 * while the budget is exceeded (the stage waits for you, it is never
 * downgraded to a cheaper model).
 */
export const BUDGET_POLICIES = ['WARN_ONLY', 'STOP_NEW_RUNS'] as const;
export type BudgetPolicy = (typeof BUDGET_POLICIES)[number];

export type BudgetState = 'ok' | 'warning' | 'critical' | 'exceeded';

export type CapacityStatus = 'ok' | 'warning' | 'exhausted' | 'unknown';

export const ANOMALY_KINDS = [
  'excessive_retries',
  'duplicate_call',
  'repeated_context',
  'failed_call_spend',
  'abnormal_task_cost',
  'abnormal_token_growth',
  'model_escalation',
  'review_fix_loop',
] as const;
export type AnomalyKind = (typeof ANOMALY_KINDS)[number];

export type HealthState = 'healthy' | 'degraded' | 'partial' | 'unavailable';

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** Normalised token counts. Input excludes cache reads and writes; output includes reasoning. */
export interface UsageTokens {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** Subset of output, informational. */
  reasoning: number | null;
  /** input + output + cacheRead + cacheWrite of the parts that are known; null when none is. */
  total: number | null;
}

/** Usage of one model inside one attempt. */
export interface UsageEventLine {
  model: string;
  tokens: UsageTokens;
  cacheWrite1h: number | null;
  providerCostNanos: number | null;
  calculatedCostNanos: number | null;
  pricingVersionId: string | null;
}

/** One actual provider attempt — the unit of accounting. */
export interface UsageEvent {
  id: string;
  /** The execution id the attempt was dispatched under; unique, so an attempt is never counted twice. */
  executionId: string;
  origin: UsageOrigin;
  provider: string;
  billing: UsageBilling;
  agentId: string;
  /** Model requested (`default` when the CLI chose). */
  model: string;
  /** Model the provider says it ran, when it says. */
  providerModelId: string | null;
  providerRequestId: string | null;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  taskTitle: string | null;
  /** Stage instance (one per stage attempt); null outside a workflow stage. */
  runId: string | null;
  workflowId: string | null;
  workflowStep: string | null;
  agentRole: string | null;
  mode: string | null;
  effort: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  apiDurationMs: number | null;
  turns: number | null;
  tokens: UsageTokens;
  retryIndex: number;
  retryParentEventId: string | null;
  attemptReason: AttemptReason;
  fallbackFromModel: string | null;
  fallbackToModel: string | null;
  providerCostNanos: number | null;
  calculatedCostNanos: number | null;
  /** Cost shown and summed: provider-reported when present, else calculated, else null (Unknown). */
  displayCostNanos: number | null;
  currency: 'USD';
  costSource: CostSource;
  pricingVersionId: string | null;
  status: UsageEventStatus;
  errorClass: string | null;
  promptChars: number | null;
  /** First 12 hex characters of the prompt's SHA-256 — for duplicate detection only. */
  promptHash: string | null;
  createdAt: string;
}

export interface UsageEventDetail extends UsageEvent {
  lines: UsageEventLine[];
  revisions: CostRevision[];
}

/** Audit record of a controlled cost recalculation (Unknown → Calculated). */
export interface CostRevision {
  id: string;
  eventId: string;
  previousSource: CostSource;
  newSource: CostSource;
  calculatedCostNanos: number | null;
  pricingVersionId: string | null;
  reason: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** Price per token in nano-dollars; null means that dimension is not priced separately. */
export interface PricingVersion {
  id: string;
  provider: string;
  providerModelId: string;
  inputNanos: number;
  outputNanos: number;
  cacheReadNanos: number | null;
  cacheWriteNanos: number | null;
  cacheWrite1hNanos: number | null;
  currency: 'USD';
  effectiveFrom: string;
  effectiveTo: string | null;
  source: string;
  verification: PricingVerification;
  lastVerifiedAt: string | null;
  createdAt: string;
}

const perMillion = z.number().min(0).max(100_000);

/** Prices entered per million tokens, as providers publish them. */
export const pricingInputSchema = z.object({
  provider: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/),
  providerModelId: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:/\-[\]]*$/),
  inputPerMillion: perMillion,
  outputPerMillion: perMillion,
  cacheReadPerMillion: perMillion.nullable().default(null),
  cacheWritePerMillion: perMillion.nullable().default(null),
  cacheWrite1hPerMillion: perMillion.nullable().default(null),
  effectiveFrom: z.iso.datetime().optional(),
  source: z.string().min(3).max(300),
  verification: z.enum(PRICING_VERIFICATION).default('documented'),
});
export type PricingInput = z.infer<typeof pricingInputSchema>;

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export interface CapacitySnapshot {
  id: string;
  provider: string;
  agentId: string;
  metric: string;
  label: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  status: CapacityStatus;
  resetAt: string | null;
  source: string;
  confidence: MetricConfidence;
  capturedAt: string;
  detail: string | null;
}

/** Latest reading per metric, judged for freshness when read. */
export interface CapacityReading extends CapacitySnapshot {
  stale: boolean;
  /** Why the reading is stale: its age, or a window that has reset since. */
  staleReason: string | null;
}

/**
 * Whether a reading means the agent cannot run now: a fresh `exhausted`
 * reading of anything but paid overage (extra usage past the subscription,
 * which Subscription Only mode never uses). Stale readings never block, so an
 * old reading cannot hold an agent back after credits are added or a window
 * resets.
 */
export function blocksRuns(reading: CapacityReading): boolean {
  return reading.status === 'exhausted' && !reading.stale && reading.metric !== 'overage';
}

export interface ProviderCapabilityView {
  tokenUsage: boolean;
  providerCost: boolean;
  credit: boolean;
  quota: boolean;
  rateLimits: boolean;
  cacheTokens: boolean;
  reasoningTokens: boolean;
  resetTime: boolean;
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface Budget {
  id: string;
  scopeType: BudgetScope;
  /** Provider, repository id, model, agent id or task id; null for GLOBAL. */
  scopeId: string | null;
  period: BudgetPeriod;
  amountNanos: number;
  currency: 'USD';
  warningThreshold: number;
  criticalThreshold: number;
  policy: BudgetPolicy;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetStatus extends Budget {
  scopeLabel: string;
  periodStart: string | null;
  periodEnd: string | null;
  spentNanos: number;
  remainingNanos: number;
  usedRatio: number;
  state: BudgetState;
  /** Attempts in scope whose cost is Unknown and therefore not counted. */
  unknownCostEvents: number;
}

const budgetBase = z.object({
  scopeType: z.enum(BUDGET_SCOPES),
  scopeId: z.string().min(1).max(200).nullable().default(null),
  period: z.enum(BUDGET_PERIODS),
  // At least one nano-dollar: a smaller amount would round to zero and divide by it (audit F-38).
  amountUsd: z.number().min(1e-9).max(10_000_000),
  warningThreshold: z.number().min(0.05).max(1).default(0.8),
  criticalThreshold: z.number().min(0.05).max(1).default(0.95),
  policy: z.enum(BUDGET_POLICIES).default('WARN_ONLY'),
  enabled: z.boolean().default(true),
});

export const budgetInputSchema = budgetBase
  .refine((b) => (b.scopeType === 'GLOBAL') === (b.scopeId === null), { message: 'A global budget has no scope; every other scope needs one', path: ['scopeId'] })
  .refine((b) => b.warningThreshold <= b.criticalThreshold, { message: 'The warning threshold must not be above the critical one', path: ['warningThreshold'] });
export type BudgetInput = z.infer<typeof budgetInputSchema>;

export const budgetUpdateSchema = budgetBase
  .pick({ amountUsd: true, warningThreshold: true, criticalThreshold: true, policy: true, enabled: true })
  .partial()
  .refine((b) => b.warningThreshold === undefined || b.criticalThreshold === undefined || b.warningThreshold <= b.criticalThreshold, {
    message: 'The warning threshold must not be above the critical one',
    path: ['warningThreshold'],
  });
export type BudgetUpdate = z.infer<typeof budgetUpdateSchema>;

// ---------------------------------------------------------------------------
// Queries and read models
// ---------------------------------------------------------------------------

export const usageFilterSchema = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  provider: z.string().max(40).optional(),
  model: z.string().max(120).optional(),
  agentId: z.string().max(64).optional(),
  projectId: z.string().max(200).optional(),
  taskId: z.string().max(40).optional(),
  runId: z.string().max(200).optional(),
  role: z.string().max(40).optional(),
  status: z.enum(USAGE_EVENT_STATUSES).optional(),
  costSource: z.enum(COST_SOURCES).optional(),
  effort: z.string().max(20).optional(),
  taskType: z.string().max(64).optional(),
  /** Task title or id, run id, or provider request id. */
  q: z.string().max(200).optional(),
});
export type UsageFilter = z.infer<typeof usageFilterSchema>;

export const usagePageSchema = usageFilterSchema.extend({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const usageTaskListSchema = usageFilterSchema.extend({
  sort: z.enum(['cost', 'tokens', 'requests', 'recent']).default('cost'),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const USAGE_EXPORT_DATASETS = ['events', 'tasks', 'models'] as const;
export const usageExportSchema = usageFilterSchema.extend({
  dataset: z.enum(USAGE_EXPORT_DATASETS),
  format: z.enum(['csv', 'json']),
});

/** Sums over a set of attempts. Cost sums include only attempts whose cost is known. */
export interface UsageTotals {
  requests: number;
  succeeded: number;
  failed: number;
  costNanos: number;
  /** Attempts whose cost is Unknown — excluded from `costNanos`. */
  unknownCostRequests: number;
  providerCostRequests: number;
  calculatedCostRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  /** Attempts that reported no token usage at all. */
  unreportedTokenRequests: number;
  durationMs: number;
  /** Cost of attempts that did not succeed. */
  failedCostNanos: number;
  /** Cost of attempts that were retries or re-runs. */
  retryCostNanos: number;
  /** Attempts that were retries, re-runs or reroutes of an earlier attempt. */
  retryRequests: number;
}

export interface UsageBreakdownRow {
  key: string;
  label: string;
  totals: UsageTotals;
  tasks: number;
  medianTaskCostNanos: number | null;
  costPerSuccessfulTaskNanos: number | null;
  retryRate: number | null;
  failureRate: number | null;
  medianLatencyMs: number | null;
  cacheHitRate: number | null;
  shareOfCost: number | null;
  /** Extra columns by view: provider for models, model mix for agents. */
  extra?: Record<string, string | number | null>;
}

export interface UsageTrendPoint {
  /** Local hour `YYYY-MM-DDTHH`, date `YYYY-MM-DD`, or the Monday of a week for ranges over 92 days. */
  bucket: string;
  costNanos: number;
  totalTokens: number;
  requests: number;
  unknownCostRequests: number;
}

export interface UsageTaskRow {
  taskId: string;
  taskTitle: string | null;
  projectId: string | null;
  projectName: string | null;
  workflowId: string | null;
  taskStatus: string | null;
  finalStatus: string | null;
  totals: UsageTotals;
  models: string[];
  agents: string[];
  retries: number;
  firstAt: string;
  lastAt: string;
}

export interface UsageStageCost {
  runId: string | null;
  stageKey: string;
  stageName: string;
  role: string | null;
  agentId: string | null;
  models: string[];
  attempts: number;
  status: string | null;
  totals: UsageTotals;
}

export interface UsageTaskLedger {
  task: UsageTaskRow;
  live: boolean;
  /** Stage runs in workflow order, then Chairman and other runs. */
  flow: UsageStageCost[];
  events: UsageEvent[];
  budgets: BudgetStatus[];
  anomalies: UsageAnomaly[];
  reconciliation: { eventTotalNanos: number; flowTotalNanos: number; matches: boolean };
}

export interface UsageAnomaly {
  id: string;
  kind: AnomalyKind;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  /** Plain explanation of the trigger: the rule, the threshold and the measured value. */
  explanation: string;
  taskId: string | null;
  runId: string | null;
  eventIds: string[];
  costNanos: number | null;
  detectedAt: string;
}

export interface ProviderSummary {
  provider: string;
  agentIds: string[];
  billing: UsageBilling[];
  totals: UsageTotals;
  usageLimitEvents: number;
  capabilities: ProviderCapabilityView | null;
  capacity: CapacityReading[];
  lastCapacityAt: string | null;
}

export interface HealthCheck {
  key: 'ingestion' | 'cost' | 'aggregates' | 'capacity' | 'pricing' | 'reconciliation';
  label: string;
  state: HealthState;
  detail: string;
}

export interface ReconciliationResult {
  ranAt: string;
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; expected: number; actual: number; detail: string }>;
}

export interface UsageOverview {
  range: { from: string; to: string };
  trackingStartedAt: string | null;
  totals: UsageTotals;
  today: UsageTotals;
  month: UsageTotals;
  costPerSuccessfulTaskNanos: number | null;
  successfulTasks: number;
  failedTasks: number;
  averageTaskCostNanos: number | null;
  trend: UsageTrendPoint[];
  providers: UsageBreakdownRow[];
  models: UsageBreakdownRow[];
  topTasks: UsageTaskRow[];
  anomalies: UsageAnomaly[];
  capacity: ProviderSummary[];
  budgets: BudgetStatus[];
  health: HealthCheck[];
  billingNote: string;
  simulated: boolean;
}

export interface UsageEventPage {
  items: UsageEvent[];
  nextCursor: string | null;
  total: number;
}

export interface UsageTaskPage {
  items: UsageTaskRow[];
  total: number;
  offset: number;
}

export interface UsageHealth {
  checks: HealthCheck[];
  reconciliation: ReconciliationResult | null;
  pendingWrites: number;
  lastIngestError: string | null;
}

export interface RecalculationResult {
  examined: number;
  recalculated: number;
  stillUnknown: number;
}

/** A compact live meter for one task (Task Detail inspector). */
export interface UsageLiveMeter {
  taskId: string;
  totals: UsageTotals;
  retries: number;
  currentAgentId: string | null;
  currentStage: string | null;
  budgets: BudgetStatus[];
}

/**
 * "$1.23", "$0.0331", "<$0.0001", "$12,345.67" from nano-dollars; "Unknown"
 * for null. Small amounts keep enough digits to stay non-zero and honest.
 */
export function formatUsd(nanos: number | null | undefined): string {
  if (nanos === null || nanos === undefined) return 'Unknown';
  const usd = nanos / NANOS_PER_USD;
  if (usd === 0) return '$0.00';
  if (usd < 0.0001) return '<$0.0001';
  const digits = usd < 1 ? 4 : 2;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// ---------------------------------------------------------------------------
// Labels (UI and exports share one vocabulary)
// ---------------------------------------------------------------------------

export const COST_SOURCE_LABEL: Record<CostSource, string> = { PROVIDER: 'Provider', CALCULATED: 'Calculated', ESTIMATED: 'Estimated', UNKNOWN: 'Unknown' };
export const COST_SOURCE_HELP: Record<CostSource, string> = {
  PROVIDER: 'Reported by the provider for this run.',
  CALCULATED: 'Calculated from the reported tokens and the price in force when the run started.',
  ESTIMATED: 'Estimated from incomplete data.',
  UNKNOWN: 'Not reported and no verified price: not included in totals.',
};
export const CONFIDENCE_LABEL: Record<MetricConfidence, string> = { LIVE: 'Live', CALCULATED: 'Calculated', ESTIMATED: 'Estimated', UNAVAILABLE: 'Unavailable' };
export const ATTEMPT_REASON_LABEL: Record<AttemptReason, string> = { initial: 'First attempt', retry: 'Retry after an error', rerun: 'Re-run', reroute: 'Rerouted' };
export const USAGE_ORIGIN_LABEL: Record<UsageOrigin, string> = { stage: 'Workflow stage', chairman: 'Chairman', source_control: 'Source Control', ask: 'Ask' };
export const USAGE_BILLING_LABEL: Record<UsageBilling, string> = { subscription: 'Subscription', api: 'API billing', simulated: 'Simulated', unknown: 'Unknown billing' };
export const BUDGET_SCOPE_LABEL: Record<BudgetScope, string> = { GLOBAL: 'All usage', PROVIDER: 'Provider', PROJECT: 'Repository', MODEL: 'Model', AGENT: 'Agent', TASK: 'Task' };
export const BUDGET_PERIOD_LABEL: Record<BudgetPeriod, string> = { day: 'Daily', week: 'Weekly', month: 'Monthly', total: 'Whole task' };
export const BUDGET_POLICY_LABEL: Record<BudgetPolicy, string> = { WARN_ONLY: 'Warn only', STOP_NEW_RUNS: 'Stop new runs' };
export const ANOMALY_KIND_LABEL: Record<AnomalyKind, string> = {
  excessive_retries: 'Excessive retries',
  duplicate_call: 'Duplicate request',
  repeated_context: 'Repeated large context',
  failed_call_spend: 'Spend on failed attempts',
  abnormal_task_cost: 'Unusual task cost',
  abnormal_token_growth: 'Context growth',
  model_escalation: 'Model escalation',
  review_fix_loop: 'Review and fix loop',
};

/** 950 → "950", 12,900 → "12.9K", 4,200,000 → "4.2M". */
export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined) return 'Not reported';
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}K`;
  if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
  return `${(count / 1_000_000_000).toFixed(1)}B`;
}

/** 0.1234 → "12.3%"; null → "—". */
export function formatRatio(ratio: number | null | undefined): string {
  return ratio === null || ratio === undefined || !Number.isFinite(ratio) ? '—' : `${(ratio * 100).toFixed(1)}%`;
}
