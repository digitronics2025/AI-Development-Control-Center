import type {
  AgentHealthState,
  ApprovalKind,
  ApprovalStatus,
  ArtifactType,
  BillingMode,
  CommandKind,
  CommandRisk,
  ErrorClass,
  EventType,
  ExecutionStatus,
  PermissionLevel,
  Role,
  StageKind,
  StageStatus,
  TaskMode,
  TaskStatus,
  TestRunStatus,
} from './constants.js';
import type { DirectiveKind, DirectiveRule, DirectiveScope, DirectiveState } from './chairman.js';
import type { PolicyMode, RepositoryRuntime } from './tools.js';
import type {
  AgentSettings,
  GitMode,
  ReleaseConfig,
  RepositoryCommand,
  RoleAssignments,
  TaskOverrides,
  WorkflowProfile,
} from './schemas.js';

export type Iso = string;

export interface ResolvedAssignment {
  agentId: string;
  model: string;
  effort: string;
}

export interface TaskBlocker {
  /** hard_blocker and limit are set by the Chairman on supervised tasks. */
  /** `decision`: a work stage said the task cannot be done right without the operator's answer (`BLOCKED ON OPERATOR:`). */
  kind: 'approval' | 'error' | 'usage' | 'auth' | 'fix_limit' | 'interrupted' | 'tests_missing' | 'queued' | 'hard_blocker' | 'limit' | 'decision';
  message: string;
  errorClass?: ErrorClass;
  approvalId?: string;
  stageKey?: string;
}

export interface TaskLastEvent {
  type: EventType;
  message: string;
  at: Iso;
}

export interface TaskGitInfo {
  baselineCommit: string | null;
  baselineBranch: string | null;
  taskBranch: string | null;
  preexistingChanges: string[];
  commits: string[];
  /** Isolated worktree the task runs in (Git mode `worktree`); null once removed or when unused. */
  worktreePath?: string | null;
  /** The task ran in a worktree (kept after it is removed, so views diff the branch instead). */
  isolated?: boolean;
  /** Multi-repository tasks: the task workspace folder holding one worktree per repository; null once removed. */
  workspacePath?: string | null;
  /** Multi-repository tasks: this repository's folder inside the workspace. */
  folder?: string | null;
  /** The task's release, once one was asked for (docs/plans/RELEASE_STAGE_PLAN.md). */
  release?: TaskRelease | null;
}

/**
 * publishing/proving: in progress. live: every configured proof passed.
 * published_unconfirmed: pushed, but not proved live in time (or the provider
 * could not be read). failed: the push was rejected or the provider reported a
 * failed build. refused: a check stopped it before anything was sent.
 */
export type ReleaseState = 'publishing' | 'proving' | 'live' | 'published_unconfirmed' | 'failed' | 'refused';

/** What each configured proof saw, most recent read. */
export interface ReleaseEvidence {
  /** The Pages project's live deployment before the push. */
  before?: { deploymentId: string | null; commit: string | null } | null;
  cloudflarePages?: {
    project: string;
    ok: boolean;
    /** The live production deployment Cloudflare reported. */
    deploymentId: string | null;
    commit: string | null;
    stage: string | null;
    status: string | null;
    url: string | null;
    /** The newest production deployment built from the pushed commit, when it is not (yet) the live one. */
    candidate?: { deploymentId: string; stage: string | null; status: string | null; url: string | null } | null;
    note: string;
  } | null;
  versionUrl?: { url: string; ok: boolean; status: number | null; excerpt: string | null; note: string } | null;
  up?: { url: string; ok: boolean; status: number | null; note: string } | null;
  checkedAt?: Iso | null;
}

/** Check setup (docs/plans/RELEASE_STAGE_PLAN.md §3.2): read-only checks of a release setting; nothing is sent. */
export interface ReleaseSetupCheck {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface TaskRelease {
  state: ReleaseState;
  commit: string;
  /** The commit's tree, which matched a tree the task's checks passed on. */
  tree: string | null;
  target: { remote: string; branch: string; liveUrl: string };
  /** How the release was started: the workflow's Release stage or the Release button. */
  via: 'stage' | 'button';
  approvalId: string | null;
  requestedAt: Iso;
  publishedAt: Iso | null;
  liveConfirmedAt: Iso | null;
  evidence: ReleaseEvidence;
  /** Why it was refused, failed or is unconfirmed, in plain words. */
  reason: string | null;
}

/** One repository a task works in (docs/plans/MULTI_REPO_TASKS_PLAN.md). */
export interface TaskRepositoryRef {
  id: string;
  name: string;
  /** Its folder in the task workspace; null for a single-repository task. */
  folder: string | null;
  primary: boolean;
  /** The repository's own folder on this machine (the task header says when a task works there). */
  path?: string;
}

export interface TaskAttachment {
  name: string;
  path: string;
  size: number;
}

export type FinalStatus = 'READY' | 'NEEDS_USER_ACTION';

/** List/summary projection pushed over WebSocket on every change. */
export interface TaskSummary {
  id: string;
  title: string;
  repositoryId: string;
  repositoryName: string;
  /**
   * Every repository the task works in, primary first; one entry for a
   * single-repository task. Absent on records written before it existed
   * (cloud snapshots, older nodes).
   */
  repositories?: TaskRepositoryRef[];
  workflowId: string;
  workflowName: string;
  mode: TaskMode;
  status: TaskStatus;
  currentStageKey: string | null;
  /** The stage instance currently or most recently run for `currentStageKey`. */
  currentStageId: string | null;
  currentStageName: string | null;
  currentAssignment: ResolvedAssignment | null;
  stageProgress: { total: number; completed: number; currentIndex: number | null };
  fixCycles: number;
  /** Chairman supervision is on for this task (docs/systems/chairman.md). */
  supervised: boolean;
  /** Recovery cycles the Chairman has started; each resets the local fix budget. */
  recoveryCycle: number;
  /** Increments on every material state change; stale decisions are rejected against it. */
  version: number;
  blocker: TaskBlocker | null;
  lastEvent: TaskLastEvent | null;
  finalStatus: FinalStatus | null;
  /** The task's release state, for the list badge; null when it was never released. */
  releaseState?: ReleaseState | null;
  pauseRequested: boolean;
  /** Pause at the next stage boundary (the running stage finishes first). */
  pauseAfterStage: boolean;
  createdAt: Iso;
  startedAt: Iso | null;
  finishedAt: Iso | null;
  updatedAt: Iso;
}

export interface TaskDetail extends TaskSummary {
  description: string;
  /** Execution policy this task runs under (docs/plans/tool-layer-v2). */
  policyMode: PolicyMode;
  workflow: WorkflowProfile;
  overrides: TaskOverrides;
  autoApproveUpToLevel: PermissionLevel;
  maxFixCycles: number;
  git: TaskGitInfo;
  attachments: TaskAttachment[];
  /** Resolved assignment for every stage in the workflow, overrides applied. */
  assignments: Record<string, ResolvedAssignment>;
  stages: StageInstance[];
}

export interface StageInstance {
  id: string;
  taskId: string;
  stageKey: string;
  name: string;
  role: Role;
  kind: StageKind;
  status: StageStatus;
  agentId: string | null;
  model: string | null;
  effort: string | null;
  permissionLevel: PermissionLevel;
  attempt: number;
  cycle: number;
  verdict: 'PASS' | 'FAIL' | null;
  summary: string | null;
  errorClass: ErrorClass | null;
  errorMessage: string | null;
  startedAt: Iso | null;
  finishedAt: Iso | null;
  createdAt: Iso;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  type: EventType;
  stageId: string | null;
  message: string;
  data: Record<string, unknown>;
  at: Iso;
}

export interface Execution {
  id: string;
  taskId: string;
  stageId: string | null;
  kind: 'agent' | 'command' | 'tool';
  agentId: string | null;
  model: string | null;
  effort: string | null;
  command: string;
  cwd: string;
  status: ExecutionStatus;
  exitCode: number | null;
  errorClass: ErrorClass | null;
  errorMessage: string | null;
  pid: number | null;
  startedAt: Iso;
  finishedAt: Iso | null;
  durationMs: number | null;
}

export interface LogLine {
  executionId: string;
  seq: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  at: Iso;
}

export interface Directive {
  id: string;
  taskId: string;
  text: string;
  /** Delivery: queued until an agent stage has received it. */
  status: 'queued' | 'applied';
  pauseRequested: boolean;
  createdAt: Iso;
  appliedAt: Iso | null;
  appliedStageKey: string | null;
  scope: DirectiveScope;
  kind: DirectiveKind;
  /** Lifecycle: removed and superseded directives no longer reach any stage. */
  state: DirectiveState;
  rule: DirectiveRule | null;
  sourceMessageId: string | null;
  removedAt: Iso | null;
  supersededBy: string | null;
}

export interface Artifact {
  id: string;
  taskId: string;
  stageId: string | null;
  stageKey: string | null;
  name: string;
  type: ArtifactType;
  mime: string;
  size: number;
  createdAt: Iso;
}

export interface Approval {
  id: string;
  taskId: string;
  taskTitle: string;
  repositoryName: string;
  stageId: string | null;
  stageKey: string | null;
  stageName: string | null;
  kind: ApprovalKind;
  requestedBy: string;
  action: string;
  command: string | null;
  permissionLevel: PermissionLevel;
  risk: CommandRisk;
  reason: string;
  riskExplanation: string;
  environment: string | null;
  /** Confirmation phrase the approver must type (level 5 / dangerous only). */
  confirmationPhrase: string | null;
  status: ApprovalStatus;
  note: string | null;
  createdAt: Iso;
  resolvedAt: Iso | null;
}

export interface TestRun {
  id: string;
  taskId: string;
  stageId: string | null;
  executionId: string | null;
  name: string;
  kind: CommandKind;
  command: string;
  status: TestRunStatus;
  exitCode: number | null;
  durationMs: number | null;
  summary: string | null;
  startedAt: Iso | null;
  finishedAt: Iso | null;
  /** The repository the command ran in; null for a single-repository task (docs/plans/MULTI_REPO_TASKS_PLAN.md). */
  repositoryId?: string | null;
  /** Ids of the failing tests, parsed from the whole output (redacted, at most 500). */
  failures?: string[] | null;
  /** A failed run compared with the baseline commit (docs/plans/AUTOPILOT_GATES_PLAN.md §3.B). */
  classification?: TestFailureClass | null;
  /** The working tree the command ran on, for reusing a pass on identical files (§3.E). */
  treeId?: string | null;
  /** The earlier passing run this one reuses instead of running again (§3.E). */
  reusedFrom?: string | null;
}

/** new: not failing on the baseline; preexisting: every failure already failed there; unknown: could not tell (treated as new). */
export type TestFailureClass = 'new' | 'preexisting' | 'unknown';

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  additions: number | null;
  deletions: number | null;
  /** task = created by this task; preexisting = user work present at baseline; both = user file the task also touched. */
  origin: 'task' | 'preexisting' | 'both';
  /** The repository the path belongs to (paths are relative to it); set on multi-repository tasks. */
  repositoryId?: string;
}

export interface TaskChanges {
  baselineCommit: string | null;
  baselineBranch: string | null;
  taskBranch: string | null;
  currentBranch: string | null;
  files: ChangedFile[];
  preexistingWarning: boolean;
  totals: { files: number; additions: number; deletions: number };
  /** The repository these changes are in (multi-repository tasks). */
  repositoryId?: string;
  repositoryName?: string;
  folder?: string | null;
  /** Multi-repository tasks: one entry per repository, primary first. The flat fields above are the primary's. */
  repositories?: TaskChanges[];
}

export interface RepositoryStatus {
  available: boolean;
  isGitRepo: boolean;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  dirtyCount: number;
  /** The branch's upstream, e.g. `origin/main`; null without one. */
  upstream: string | null;
  /** Commits not on the upstream / on the upstream but not here, as of the last fetch. Null without an upstream. */
  ahead: number | null;
  behind: number | null;
  error: string | null;
  checkedAt: Iso;
}

/** What background sync did with one repository (docs/systems/repository-automation.md). */
export type RepositorySyncOutcome = 'up-to-date' | 'fast-forwarded' | 'behind-dirty' | 'ahead' | 'diverged' | 'skipped' | 'failed' | 'remote-gone';

export interface RepositorySyncResult {
  repositoryId: string;
  /**
   * `remote-gone`: the remote says the repository does not exist while another
   * repository of the same account fetched fine in the same run, so it is not
   * a sign-in problem. The local copy is untouched.
   */
  outcome: RepositorySyncOutcome;
  message: string;
  ahead: number | null;
  behind: number | null;
  at: Iso;
  /** `host/owner` of the upstream remote (never the full URL or credentials); null when unknown. */
  remoteOwner: string | null;
  /** The fetch failed because the remote answered that the repository does not exist. */
  remoteMissing: boolean;
}

export interface RepositoryDiscoveryReport {
  /** Folders looked at. */
  scanned: number;
  added: Array<{ id: string; name: string; path: string }>;
  errors: Array<{ path: string; message: string }>;
}

export interface RepositoryAutomationRun {
  trigger: 'startup' | 'schedule' | 'manual';
  startedAt: Iso;
  finishedAt: Iso | null;
  discovery: RepositoryDiscoveryReport | null;
  /** Count of repositories per outcome; null when sync did not run. */
  sync: Partial<Record<RepositorySyncOutcome, number>> | null;
}

export interface RepositoryAutomationStatus {
  running: boolean;
  /** Null when both discovery and sync are off, or the scheduler is not started. */
  nextRunAt: Iso | null;
  lastRun: RepositoryAutomationRun | null;
  /** Latest background-sync result per repository. */
  results: RepositorySyncResult[];
}

export interface Repository {
  id: string;
  name: string;
  path: string;
  defaultWorkflowId: string | null;
  roleOverrides: RoleAssignments;
  commands: RepositoryCommand[];
  gitMode: GitMode;
  autoApproveUpToLevel: PermissionLevel | null;
  tooling: string[];
  lastTaskId: string | null;
  /** Null = use Settings → Execution. */
  policyMode: PolicyMode | null;
  runtime: RepositoryRuntime;
  /** allow: failures already on the baseline commit are reported but do not block; block: every failure blocks. */
  preexistingFailures: 'allow' | 'block';
  /** How tested work goes live (docs/plans/RELEASE_STAGE_PLAN.md). */
  release: ReleaseConfig;
  status: RepositoryStatus;
  createdAt: Iso;
  updatedAt: Iso;
}

export interface ModelDescriptor {
  agentId: string;
  modelId: string;
  label: string;
  efforts: string[];
  defaultEffort: string | null;
  source: 'discovered' | 'builtin' | 'user';
  description: string | null;
}

export interface AgentCapabilities {
  repositoryRead: boolean;
  repositoryWrite: boolean;
  commandExecution: boolean;
  images: boolean;
  interactive: boolean;
  nonInteractive: boolean;
  modelSelection: boolean;
  effortSelection: boolean;
}

export interface AgentInfo {
  id: string;
  name: string;
  detection: { found: boolean; executablePath: string | null; version: string | null; error: string | null };
  health: {
    state: AgentHealthState;
    message: string;
    authMethod: string | null;
    billing: 'subscription' | 'api' | 'unknown';
    checkedAt: Iso | null;
  };
  capabilities: AgentCapabilities;
  models: ModelDescriptor[];
  settings: AgentSettings;
  /** The agent's last run reported it cannot run now (e.g. out of credits); null when nothing says so. */
  capacityBlock: { label: string; detail: string | null; capturedAt: Iso } | null;
}

export interface OverviewCounts {
  active: number;
  waitingForMe: number;
  failed: number;
  completedToday: number;
  pendingApprovals: number;
}

export interface ServiceHealth {
  ok: true;
  version: string;
  startedAt: Iso;
  billingMode: BillingMode;
  dataDir: string;
  host: string;
  port: number;
  simulatedAgents: boolean;
  git: { found: boolean; version: string | null };
  /** Where this binary came from: the commit it was built from (null for an unbundled dev run). */
  build: { commit: string | null; dirty: boolean; builtAt: string | null };
}

export interface PromptTemplate {
  role: Role;
  version: number;
  body: string;
  updatedAt: Iso;
  builtin: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
