/**
 * Canonical enumerations for the whole product. The orchestrator persists
 * these values verbatim, so renaming one is a data migration.
 */

export const TASK_STATUSES = [
  'DRAFT',
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'WAITING_FOR_USER',
  'WAITING_FOR_USAGE_RESET',
  'FAILED',
  'CANCELLED',
  'COMPLETED',
  'INTERRUPTED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses in which a task is still owned by the engine loop. */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['QUEUED', 'RUNNING'];
/** Statuses that need a human decision before anything else happens. */
export const ATTENTION_TASK_STATUSES: readonly TaskStatus[] = [
  'WAITING_FOR_USER',
  'WAITING_FOR_USAGE_RESET',
  'FAILED',
  'INTERRUPTED',
];
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['COMPLETED', 'CANCELLED'];

export const STAGE_STATUSES = [
  'PENDING',
  'READY',
  'STARTING',
  'RUNNING',
  'SUCCESS',
  'FAILED',
  'RETRYING',
  'WAITING_APPROVAL',
  'PAUSED',
  'CANCELLED',
  'INTERRUPTED',
  'SKIPPED',
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const ROLES = [
  'investigator',
  'planner',
  'implementer',
  'tester',
  'reviewer',
  'fixer',
  'verifier',
  'deployer',
  'reporter',
] as const;
export type Role = (typeof ROLES)[number];

/** `release`: send the tested commit live after a typed approval (docs/plans/RELEASE_STAGE_PLAN.md). */
export const STAGE_KINDS = ['agent', 'tests', 'command', 'git', 'verify', 'release'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export const TASK_MODES = ['discuss', 'autopilot'] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export const BILLING_MODES = ['subscription', 'api'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export const THEMES = ['dark', 'light', 'system'] as const;
export type ThemePreference = (typeof THEMES)[number];

export const PERMISSION_LEVELS = [1, 2, 3, 4, 5] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

export const ERROR_CLASSES = [
  'AUTH_FAILURE',
  'USAGE_LIMIT',
  'COMMAND_FAILURE',
  'MODEL_UNAVAILABLE',
  'TIMEOUT',
  'PROCESS_CRASH',
  'TEST_FAILURE',
  'CONTEXT_FAILURE',
  'PERMISSION_DENIED',
  /** A verdict stage passed without accounting for every changed file it was not shown. */
  'REVIEW_INCOMPLETE',
  'UNKNOWN',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export const EVENT_TYPES = [
  'TASK_CREATED',
  'TASK_STARTED',
  'TASK_PAUSED',
  'TASK_RESUMED',
  'TASK_QUEUED',
  'TASK_CANCELLED',
  'TASK_INTERRUPTED',
  'TASK_WAITING',
  'STAGE_STARTED',
  'STAGE_COMPLETED',
  'STAGE_FAILED',
  /** An optional stage failed: recorded as a report limitation, never a recovery (AUTOPILOT_GATES_PLAN §3.D). */
  'STAGE_OPTIONAL_FAILED',
  'STAGE_SKIPPED',
  'STAGE_RETRY',
  'AGENT_STARTED',
  'COMMAND_STARTED',
  'COMMAND_FINISHED',
  'USER_DIRECTIVE',
  'DIRECTIVE_APPLIED',
  'FILE_CHANGED',
  'GIT_BASELINE',
  'GIT_BRANCH',
  'GIT_COMMIT',
  'TEST_STARTED',
  'TEST_FAILED',
  'TEST_PASSED',
  'REVIEW_PASSED',
  'REVIEW_FAILED',
  'FIX_CYCLE',
  'REROUTED',
  'ASSIGNMENT_CHANGED',
  'APPROVAL_REQUESTED',
  'APPROVAL_RESOLVED',
  'ARTIFACT_CREATED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  // Chairman supervision (docs/systems/chairman.md). Only interventions are
  // logged here; chat traffic lives in its own table.
  'CHAIRMAN_DECISION',
  'CHAIRMAN_ACTION',
  'RECOVERY_CYCLE',
  'TASK_REDIRECTED',
  'CHECKPOINT_CREATED',
  'ROLLBACK_COMPLETED',
  'DIRECTIVE_REMOVED',
  'WATCHDOG',
  // Universal tool layer (docs/plans/tool-layer-v2). Reads are not logged
  // here — every tool call has its own row; events mark what a person
  // following the task wants to see in the timeline.
  'ENVIRONMENT_DISCOVERED',
  'TOOL_CALL',
  'CAPABILITY_ESCALATED',
  'RECOVERY_ATTEMPT',
  'PROCESS_STARTED',
  'PROCESS_STOPPED',
  'VERIFICATION',
  'WORKTREE_CREATED',
  'WORKTREE_REMOVED',
  // Releases (docs/plans/RELEASE_STAGE_PLAN.md): each carries the commit, the target and the evidence.
  'RELEASE_REQUESTED',
  'RELEASE_APPROVED',
  'RELEASE_DECLINED',
  'RELEASE_REFUSED',
  'RELEASE_PUBLISHED',
  'RELEASE_LIVE',
  'RELEASE_UNCONFIRMED',
  'RELEASE_FAILED',
  // Phone alerts (docs/plans/LEAD_TIME_PLAN.md §3.4): one per attempt, naming the event or approval it is about.
  'ALERT_SENT',
  'ALERT_NOT_SENT',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** `release`: the Release button on a completed task (a stage release uses `stage_permission`). */
export const APPROVAL_KINDS = ['stage_permission', 'plan_review', 'command', 'skip_tests', 'release'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'denied', 'cancelled'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const EXECUTION_STATUSES = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const TEST_RUN_STATUSES = ['running', 'passed', 'failed', 'not_run', 'blocked'] as const;
export type TestRunStatus = (typeof TEST_RUN_STATUSES)[number];

export const COMMAND_KINDS = [
  'lint',
  'typecheck',
  'test',
  'build',
  'e2e',
  'smoke',
  'deploy-staging',
  'other',
] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

/** Command kinds a verification ("tests") stage runs when it does not name its own. */
export const DEFAULT_VERIFY_COMMAND_KINDS: readonly CommandKind[] = ['lint', 'typecheck', 'test', 'build'];

export const ARTIFACT_TYPES = [
  'request',
  'investigation',
  'plan',
  'implementation-report',
  'review',
  'fix-report',
  'verification',
  'tests-log',
  'git-diff',
  'final-report',
  'task-json',
  'stage-output',
  /** Redacted staged diff a Staged Review task reviews (Source Control). */
  'staged-diff',
  'environment',
  'screenshot',
  'browser-report',
  'tool-output',
  /** Page evidence the operator sent from Private Browser (a re-check): never leaves this computer (remote.ts). */
  'operator-evidence',
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const AGENT_HEALTH_STATES = [
  'connected',
  'not_installed',
  'auth_required',
  'api_billing_blocked',
  'error',
  'disabled',
  'unknown',
] as const;
export type AgentHealthState = (typeof AGENT_HEALTH_STATES)[number];

export const COMMAND_RISKS = ['normal', 'elevated', 'dangerous'] as const;
export type CommandRisk = (typeof COMMAND_RISKS)[number];

/** Terminal pseudo-stage key a transition may point at. */
export const COMPLETE = 'complete';

export const DEFAULT_PORT = 4317;
export const DEFAULT_MAX_FIX_CYCLES = 3;
export const DEFAULT_AUTO_APPROVE_LEVEL: PermissionLevel = 3;
