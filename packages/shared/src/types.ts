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
import type {
  AgentSettings,
  GitMode,
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
  kind: 'approval' | 'error' | 'usage' | 'auth' | 'fix_limit' | 'interrupted' | 'tests_missing' | 'queued';
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
  blocker: TaskBlocker | null;
  lastEvent: TaskLastEvent | null;
  finalStatus: FinalStatus | null;
  pauseRequested: boolean;
  createdAt: Iso;
  startedAt: Iso | null;
  finishedAt: Iso | null;
  updatedAt: Iso;
}

export interface TaskDetail extends TaskSummary {
  description: string;
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
  kind: 'agent' | 'command';
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
  status: 'queued' | 'applied';
  pauseRequested: boolean;
  createdAt: Iso;
  appliedAt: Iso | null;
  appliedStageKey: string | null;
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
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  additions: number | null;
  deletions: number | null;
  /** task = created by this task; preexisting = user work present at baseline; both = user file the task also touched. */
  origin: 'task' | 'preexisting' | 'both';
}

export interface TaskChanges {
  baselineCommit: string | null;
  baselineBranch: string | null;
  taskBranch: string | null;
  currentBranch: string | null;
  files: ChangedFile[];
  preexistingWarning: boolean;
  totals: { files: number; additions: number; deletions: number };
}

export interface RepositoryStatus {
  available: boolean;
  isGitRepo: boolean;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  dirtyCount: number;
  error: string | null;
  checkedAt: Iso;
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
