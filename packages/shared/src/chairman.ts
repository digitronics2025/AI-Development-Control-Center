import { z } from 'zod';
import { COMMAND_KINDS, type CommandKind } from './constants.js';
import { agentIdSchema, effortSchema, modelIdSchema, slugSchema } from './schemas.js';

export { chairmanSettingsSchema, type ChairmanSettings } from './schemas.js';

/**
 * Chairman supervisor contract (docs/systems/chairman.md). The orchestrator
 * owns task state; the Chairman observes it and asks for changes only through
 * the typed actions below, which the Action Gateway validates and executes.
 */

export const CHAIRMAN_ACTION_TYPES = [
  'CONTINUE',
  'PAUSE_TASK',
  'RESUME_TASK',
  'CANCEL_ACTIVE_STAGE',
  'RETRY_STAGE',
  'RETURN_TO_STAGE',
  'REPLAN',
  'ADD_DIRECTIVE',
  'REMOVE_DIRECTIVE',
  'CHANGE_AGENT',
  'CHANGE_MODEL',
  'CHANGE_EFFORT',
  'RUN_TARGETED_TESTS',
  'RUN_FULL_TESTS',
  'RUN_E2E',
  'CREATE_CHECKPOINT',
  'ROLLBACK_CHECKPOINT',
  'MARK_HARD_BLOCKER',
  'COMPLETE_TASK',
] as const;
export type ChairmanActionType = (typeof CHAIRMAN_ACTION_TYPES)[number];

export const CHAIRMAN_HEALTH = ['PROGRESSING', 'STABLE', 'STALLED', 'REGRESSING', 'UNKNOWN'] as const;
export type ChairmanHealth = (typeof CHAIRMAN_HEALTH)[number];

/** off = task not supervised; degraded = no reasoning model, deterministic policy only. */
export const CHAIRMAN_STATUSES = ['off', 'idle', 'supervising', 'evaluating', 'degraded'] as const;
export type ChairmanStatus = (typeof CHAIRMAN_STATUSES)[number];

export const FAILURE_CATEGORIES = ['CODE_OR_TEST', 'REQUIREMENT_OR_PLAN', 'WORKER_OR_TOOL', 'ENVIRONMENT', 'AUTH_OR_EXTERNAL', 'WORKFLOW_STATE', 'UNKNOWN'] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const CHAT_INTENTS = ['QUESTION', 'STATUS', 'DIRECTIVE', 'COMMAND', 'GOAL_CHANGE', 'ROUTING_CHANGE'] as const;
export type ChatIntent = (typeof CHAT_INTENTS)[number];

export const DIRECTIVE_SCOPES = ['NEXT_RELEVANT_STAGE', 'CURRENT_TASK'] as const;
export type DirectiveScope = (typeof DIRECTIVE_SCOPES)[number];

/** constraint = "do not …"; requirement = a completion check; routing = which agent runs a stage. */
export const DIRECTIVE_KINDS = ['instruction', 'constraint', 'requirement', 'routing'] as const;
export type DirectiveKind = (typeof DIRECTIVE_KINDS)[number];

export const DIRECTIVE_STATES = ['active', 'removed', 'superseded'] as const;
export type DirectiveState = (typeof DIRECTIVE_STATES)[number];

/** Machine-checkable form of a directive, when one could be derived from its text. */
export type DirectiveRule =
  | { type: 'protect_paths'; patterns: string[] }
  | { type: 'require_check'; kinds: CommandKind[] }
  | { type: 'routing'; stageKey: string; agentId: string };

export const directiveRuleSchema: z.ZodType<DirectiveRule> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('protect_paths'), patterns: z.array(z.string().min(1).max(300)).min(1).max(20) }),
  z.object({ type: z.literal('require_check'), kinds: z.array(z.enum(COMMAND_KINDS)).min(1).max(8) }),
  z.object({ type: z.literal('routing'), stageKey: slugSchema, agentId: agentIdSchema }),
]);

const guidance = z.string().trim().max(2000).optional();

/** One schema per action: the gateway rejects anything that does not parse. */
export const chairmanActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CONTINUE'), params: z.object({}).default({}) }),
  z.object({ type: z.literal('PAUSE_TASK'), params: z.object({ when: z.enum(['now', 'after_stage']).default('now') }).default({ when: 'now' }) }),
  z.object({ type: z.literal('RESUME_TASK'), params: z.object({}).default({}) }),
  z.object({ type: z.literal('CANCEL_ACTIVE_STAGE'), params: z.object({}).default({}) }),
  z.object({ type: z.literal('RETRY_STAGE'), params: z.object({ stageKey: slugSchema.optional(), guidance }).default({}) }),
  z.object({ type: z.literal('RETURN_TO_STAGE'), params: z.object({ stageKey: slugSchema, guidance }) }),
  z.object({ type: z.literal('REPLAN'), params: z.object({ guidance }).default({}) }),
  z.object({
    type: z.literal('ADD_DIRECTIVE'),
    params: z.object({
      text: z.string().trim().min(1).max(4000),
      scope: z.enum(DIRECTIVE_SCOPES).default('CURRENT_TASK'),
      kind: z.enum(DIRECTIVE_KINDS).default('instruction'),
      rule: directiveRuleSchema.nullable().default(null),
      supersedes: z.string().max(100).optional(),
      /** Stop a running write stage so it re-runs under the new directive. */
      interrupt: z.boolean().default(false),
    }),
  }),
  z.object({ type: z.literal('REMOVE_DIRECTIVE'), params: z.object({ directiveId: z.string().min(1).max(100) }) }),
  z.object({
    type: z.literal('CHANGE_AGENT'),
    params: z.object({ stageKey: slugSchema, agentId: agentIdSchema, model: modelIdSchema.optional(), effort: effortSchema.optional(), applyToRole: z.boolean().default(false) }),
  }),
  z.object({ type: z.literal('CHANGE_MODEL'), params: z.object({ stageKey: slugSchema, model: modelIdSchema }) }),
  z.object({ type: z.literal('CHANGE_EFFORT'), params: z.object({ stageKey: slugSchema, effort: effortSchema }) }),
  z.object({ type: z.literal('RUN_TARGETED_TESTS'), params: z.object({}).default({}) }),
  z.object({ type: z.literal('RUN_FULL_TESTS'), params: z.object({}).default({}) }),
  z.object({ type: z.literal('RUN_E2E'), params: z.object({}).default({}) }),
  z.object({ type: z.literal('CREATE_CHECKPOINT'), params: z.object({ label: z.string().trim().max(120).optional() }).default({}) }),
  z.object({ type: z.literal('ROLLBACK_CHECKPOINT'), params: z.object({ checkpointId: z.string().max(100).optional() }).default({}) }),
  z.object({ type: z.literal('MARK_HARD_BLOCKER'), params: z.object({ reason: z.string().trim().min(1).max(1000) }) }),
  z.object({ type: z.literal('COMPLETE_TASK'), params: z.object({}).default({}) }),
]);
export type ChairmanActionRequest = z.output<typeof chairmanActionSchema>;
export type ChairmanActionInput = z.input<typeof chairmanActionSchema>;

export const chairmanActionBodySchema = z.object({
  action: chairmanActionSchema,
  /** Duplicate requests with the same key return the first result (reconnects, double clicks). */
  idempotencyKey: z.string().min(8).max(100),
});

export const chairmanMessageBodySchema = z.object({
  text: z.string().trim().min(1, 'Write a message').max(4000),
  clientMessageId: z.string().min(8).max(100),
});

export interface TaskLimits {
  maxRecoveryCycles: number;
  maxRuntimeMinutes: number;
  maxAgentRuns: number;
}

export interface TaskContract {
  taskId: string;
  version: number;
  goal: string;
  successCriteria: string[];
  scope: { repository: string; workflow: string };
  autonomyMode: 'FULL_AUTOPILOT' | 'DISCUSS_FIRST';
  constraints: string[];
  reason: string;
  createdAt: string;
}

export interface ChairmanState {
  taskId: string;
  supervised: boolean;
  status: ChairmanStatus;
  health: ChairmanHealth;
  recoveryCycle: number;
  limits: TaskLimits | null;
  usage: { agentRuns: number; workMs: number };
  strategySummary: string | null;
  lastRecoveryReason: string | null;
  degradedReason: string | null;
  reasoner: { agentId: string; available: boolean };
  contractVersion: number;
  updatedAt: string;
}

export type ChairmanMessageRole = 'user' | 'chairman' | 'system';
export type ChairmanMessageKind = 'message' | 'decision' | 'action';

export interface ChairmanMessage {
  id: string;
  taskId: string;
  seq: number;
  role: ChairmanMessageRole;
  kind: ChairmanMessageKind;
  body: string;
  intent: ChatIntent | null;
  status: 'pending' | 'done' | 'failed';
  decisionId: string | null;
  actionId: string | null;
  createdAt: string;
}

/** Families of recovery strategy the deterministic policy can offer. */
export const CHAIRMAN_STRATEGY_KINDS = ['rca', 'replan', 'change_agent', 'rollback', 'retry_stage'] as const;
export type ChairmanStrategyKind = (typeof CHAIRMAN_STRATEGY_KINDS)[number];

export const DIAGNOSIS_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type ChairmanDiagnosisConfidence = (typeof DIAGNOSIS_CONFIDENCES)[number];

/**
 * A short operational hypothesis about a failure. `category` always comes
 * from the deterministic failure signature; the model may only word the
 * summary and state its confidence.
 */
export interface ChairmanDiagnosis {
  category: FailureCategory;
  confidence: ChairmanDiagnosisConfidence;
  summary: string;
  source: 'policy' | 'model';
}

export const STRATEGY_OUTCOME_STATUSES = ['RUNNING', 'SUCCEEDED', 'IMPROVED', 'FAILED', 'REGRESSED', 'INCONCLUSIVE', 'SUPERSEDED'] as const;
export type ChairmanStrategyOutcomeStatus = (typeof STRATEGY_OUTCOME_STATUSES)[number];

/**
 * One recovery strategy and what objectively happened after it
 * (docs/systems/chairman.md §Strategy outcomes). Structured metadata only:
 * no logs, prompts, model replies or file contents.
 */
export interface ChairmanStrategyRun {
  decisionId: string;
  taskId: string;
  contractVersion: number;
  recoveryCycle: number;
  trigger: string;
  strategyFingerprint: string;
  strategyKind: ChairmanStrategyKind;
  targetStageKey: string | null;
  targetAgentId: string | null;
  failureSource: string;
  failureStageKey: string;
  failureCategory: FailureCategory;
  failureHash: string;
  failureCount: number | null;
  diagnosis: ChairmanDiagnosis;
  evidenceDigest: string;
  expectedResult: string;
  status: ChairmanStrategyOutcomeStatus;
  outcomeSummary: string | null;
  healthBefore: ChairmanHealth;
  healthAfter: ChairmanHealth | null;
  startedAt: string;
  evaluatedAt: string | null;
}

export interface ChairmanDecision {
  id: string;
  taskId: string;
  source: 'supervisor' | 'chat';
  trigger: string;
  taskVersion: number;
  summary: string;
  reasoningSummary: string;
  decision: string;
  expectedResult: string;
  hardBlocker: boolean;
  health: ChairmanHealth;
  reasoner: 'model' | 'policy';
  strategyFingerprint: string | null;
  createdAt: string;
  /** Recovery decisions only: the strategy's diagnosis and observed outcome. Older clients ignore it. */
  strategy?: ChairmanStrategyRun | null;
}

export type ChairmanActionStatus = 'running' | 'completed' | 'failed' | 'rejected';

export interface ChairmanAction {
  id: string;
  taskId: string;
  decisionId: string | null;
  messageId: string | null;
  type: ChairmanActionType;
  params: Record<string, unknown>;
  initiator: 'user' | 'chairman' | 'system';
  source: 'chat' | 'supervisor' | 'api';
  taskVersion: number;
  status: ChairmanActionStatus;
  reason: string | null;
  result: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface TaskCheckpoint {
  id: string;
  taskId: string;
  seq: number;
  label: string;
  reason: string;
  commit: string;
  head: string | null;
  stageKey: string | null;
  createdAt: string;
  /** git (working tree), database (SQLite/D1 backup) or deployment (live version record). V1 rows are git. */
  type?: 'git' | 'database' | 'deployment';
  /** Branch, Git status, changed files, lockfile hashes, backup location… (no secrets, no file contents). */
  metadata?: Record<string, unknown>;
  /** A task across repositories: one Git checkpoint per repository, primary first (`commit`/`head` above are the primary's). */
  parts?: TaskCheckpointPart[] | null;
}

export interface TaskCheckpointPart {
  repositoryId: string;
  folder: string | null;
  ref: string;
  commit: string;
  head: string | null;
}

export interface ChairmanOverview {
  state: ChairmanState;
  contract: TaskContract;
  messages: ChairmanMessage[];
  decisions: ChairmanDecision[];
  actions: ChairmanAction[];
  checkpoints: TaskCheckpoint[];
}

export const CHAIRMAN_STATUS_LABEL: Record<ChairmanStatus, string> = {
  off: 'Not supervising',
  idle: 'Standing by',
  supervising: 'Supervising',
  evaluating: 'Evaluating',
  degraded: 'Supervising (rules only)',
};

export const CHAIRMAN_HEALTH_LABEL: Record<ChairmanHealth, string> = {
  PROGRESSING: 'Progressing',
  STABLE: 'Stable',
  STALLED: 'Stalled',
  REGRESSING: 'Regressing',
  UNKNOWN: 'Unknown',
};

export const STRATEGY_KIND_LABEL: Record<ChairmanStrategyKind, string> = {
  rca: 'Root-cause analysis',
  replan: 'Re-plan',
  change_agent: 'Change agent',
  rollback: 'Roll back',
  retry_stage: 'Retry',
};

/** How a strategy's result reads to the operator. */
export const STRATEGY_OUTCOME_LABEL: Record<ChairmanStrategyOutcomeStatus, string> = {
  RUNNING: 'Waiting for result',
  SUCCEEDED: 'Resolved',
  IMPROVED: 'Improved',
  FAILED: 'No improvement',
  REGRESSED: 'Regressed',
  INCONCLUSIVE: 'Inconclusive',
  SUPERSEDED: 'Superseded',
};

export const FAILURE_CATEGORY_LABEL: Record<FailureCategory, string> = {
  CODE_OR_TEST: 'Code or test',
  REQUIREMENT_OR_PLAN: 'Requirement or plan',
  WORKER_OR_TOOL: 'Agent or tool',
  ENVIRONMENT: 'Environment',
  AUTH_OR_EXTERNAL: 'Provider or access',
  WORKFLOW_STATE: 'Workflow state',
  UNKNOWN: 'Unknown',
};

export const CHAIRMAN_ACTION_LABEL: Record<ChairmanActionType, string> = {
  CONTINUE: 'Continue',
  PAUSE_TASK: 'Pause task',
  RESUME_TASK: 'Resume task',
  CANCEL_ACTIVE_STAGE: 'Stop active stage',
  RETRY_STAGE: 'Retry stage',
  RETURN_TO_STAGE: 'Return to stage',
  REPLAN: 'Re-plan',
  ADD_DIRECTIVE: 'Add directive',
  REMOVE_DIRECTIVE: 'Remove directive',
  CHANGE_AGENT: 'Change agent',
  CHANGE_MODEL: 'Change model',
  CHANGE_EFFORT: 'Change effort',
  RUN_TARGETED_TESTS: 'Run tests',
  RUN_FULL_TESTS: 'Run full tests',
  RUN_E2E: 'Run end-to-end tests',
  CREATE_CHECKPOINT: 'Create checkpoint',
  ROLLBACK_CHECKPOINT: 'Roll back to checkpoint',
  MARK_HARD_BLOCKER: 'Mark hard blocker',
  COMPLETE_TASK: 'Complete task',
};
