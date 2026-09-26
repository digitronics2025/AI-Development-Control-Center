import { randomUUID } from 'node:crypto';
import type {
  AgentCapabilities,
  AgentSettings,
  Approval,
  ApprovalKind,
  ApprovalStatus,
  Artifact,
  ArtifactType,
  CommandKind,
  CommandRisk,
  Directive,
  DirectiveKind,
  DirectiveScope,
  ErrorClass,
  EventType,
  Execution,
  ExecutionStatus,
  FinalStatus,
  LogLine,
  ModelDescriptor,
  PermissionLevel,
  PromptTemplate,
  RepositoryCommand,
  Role,
  RoleAssignments,
  StageDefinition,
  StageInstance,
  StageKind,
  StageStatus,
  TaskAttachment,
  TaskBlocker,
  TaskEvent,
  TaskGitInfo,
  TaskLastEvent,
  TaskMode,
  TaskOverrides,
  TaskLimits,
  TaskStatus,
  TestRun,
  TestRunStatus,
  WorkflowProfile,
  GitMode,
  PolicyMode,
  ReleaseConfig,
  RepositoryRuntime,
  TestSelectionMode,
} from '@acc/shared';
import { releaseConfigSchema, repositoryRuntimeSchema } from '@acc/shared';
import type { AgentDetectionResult, AgentHealth } from '@acc/agent-sdk';
import type { Db } from '../db/database.js';

export const now = (): string => new Date().toISOString();
export const newId = (): string => randomUUID();

function parse<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
const json = (value: unknown): string => JSON.stringify(value ?? null);

// ---------------------------------------------------------------------------
// Records (internal shapes; API projections are built by the services)
// ---------------------------------------------------------------------------

export interface TaskGitRecord extends TaskGitInfo {
  baselineSnapshotId: string | null;
}

export interface TaskRecord {
  id: string;
  seq: number;
  title: string;
  description: string;
  repositoryId: string;
  workflowId: string;
  workflow: WorkflowProfile;
  mode: TaskMode;
  status: TaskStatus;
  currentStageKey: string | null;
  currentStageId: string | null;
  overrides: TaskOverrides;
  autoApproveUpToLevel: PermissionLevel;
  maxFixCycles: number;
  fixCycles: number;
  pauseRequested: boolean;
  /** Pause at the next stage boundary instead of stopping the running stage. */
  pauseAfterStage: boolean;
  /** Chairman supervision is on for this task. */
  supervised: boolean;
  recoveryCycle: number;
  /** Supervised tasks only; null for unsupervised ones. */
  limits: TaskLimits | null;
  /** Execution policy fixed at creation (tool layer V2); null for tasks created before it. */
  policyMode: PolicyMode | null;
  /** Command kinds the next tests stage runs in addition to its own (one-shot). */
  extraCheckKinds: CommandKind[];
  /** Bumped by the store on every material change; never set directly. */
  version: number;
  blocker: TaskBlocker | null;
  lastEvent: TaskLastEvent | null;
  finalStatus: FinalStatus | null;
  git: TaskGitRecord;
  attachments: TaskAttachment[];
  promptVersions: Record<string, number>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** A repository a task works in besides its primary one (docs/plans/MULTI_REPO_TASKS_PLAN.md). */
export interface LinkedRepositoryRecord {
  taskId: string;
  repositoryId: string;
  /** 1-based order after the primary. */
  position: number;
  /** Its folder in the task workspace. */
  folder: string;
  git: TaskGitRecord;
}

/** Identifies one baseline result: a command, as configured, on one commit of one repository. */
export interface BaselineCheckKey {
  repositoryId: string;
  baselineCommit: string;
  commandId: string;
  /** Hash of the command line, so an edited command is never judged by an old result. */
  commandSha: string;
}

export interface BaselineCheckRecord extends BaselineCheckKey {
  id: string;
  /** error: the baseline could not be checked (no worktree, install failed, timed out). */
  status: 'passed' | 'failed' | 'error';
  summary: string | null;
  failures: string[];
  durationMs: number | null;
  createdAt: string;
}

export interface RepositoryRecord {
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
  policyMode: PolicyMode | null;
  runtime: RepositoryRuntime;
  /** allow: failures already on the baseline are reported but do not block; block: every failure blocks (§3.B). */
  preexistingFailures: 'allow' | 'block';
  /** changed: affected unit tests only (docs/plans/AFFECTED_TESTS_PLAN.md); anything else reads as full. */
  testSelection: TestSelectionMode;
  /** How tested work goes live (docs/plans/RELEASE_STAGE_PLAN.md); `none` never releases. */
  release: ReleaseConfig;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  settings: AgentSettings;
  detection: AgentDetectionResult | null;
  health: AgentHealth | null;
  capabilities: AgentCapabilities | null;
  updatedAt: string;
}

/** Stored approval; the API view adds task title, repository and stage names. */
export type ApprovalRecord = Omit<Approval, 'taskTitle' | 'repositoryName' | 'stageName'>;

export interface SnapshotRecord {
  id: string;
  taskId: string;
  stageId: string | null;
  kind: 'baseline' | 'final';
  branch: string | null;
  head: string | null;
  files: Array<{ path: string; code: string; hash: string | null }>;
  createdAt: string;
}

export interface ArtifactRecord extends Artifact {
  path: string;
}

const EMPTY_GIT: TaskGitRecord = {
  baselineCommit: null,
  baselineBranch: null,
  taskBranch: null,
  preexistingChanges: [],
  commits: [],
  baselineSnapshotId: null,
};

type Row = Record<string, any>;

const toTask = (r: Row): TaskRecord => ({
  id: r.id,
  seq: r.seq,
  title: r.title,
  description: r.description,
  repositoryId: r.repository_id,
  workflowId: r.workflow_id,
  workflow: parse(r.workflow_snapshot, null as unknown as WorkflowProfile),
  mode: r.mode,
  status: r.status,
  currentStageKey: r.current_stage_key,
  currentStageId: r.current_stage_id,
  overrides: parse(r.overrides, { roles: {}, stages: {} }),
  autoApproveUpToLevel: r.auto_approve_level,
  maxFixCycles: r.max_fix_cycles,
  fixCycles: r.fix_cycles,
  pauseRequested: r.pause_requested === 1,
  pauseAfterStage: r.pause_after_stage === 1,
  supervised: r.supervised === 1,
  recoveryCycle: r.recovery_cycle ?? 0,
  limits: parse(r.limits, null),
  policyMode: r.policy_mode ?? null,
  extraCheckKinds: parse(r.extra_check_kinds, []),
  version: r.version ?? 0,
  blocker: parse(r.blocker, null),
  lastEvent: parse(r.last_event, null),
  finalStatus: r.final_status,
  git: { ...EMPTY_GIT, ...parse(r.git, {}) },
  attachments: parse(r.attachments, []),
  promptVersions: parse(r.prompt_versions, {}),
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  updatedAt: r.updated_at,
});

const toStage = (r: Row): StageInstance => ({
  id: r.id,
  taskId: r.task_id,
  stageKey: r.stage_key,
  name: r.name,
  role: r.role,
  kind: r.kind,
  status: r.status,
  agentId: r.agent_id,
  model: r.model,
  effort: r.effort,
  permissionLevel: r.permission_level,
  attempt: r.attempt,
  cycle: r.cycle,
  verdict: r.verdict,
  summary: r.summary,
  errorClass: r.error_class,
  errorMessage: r.error_message,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  createdAt: r.created_at,
});

const toExecution = (r: Row): Execution => ({
  id: r.id,
  taskId: r.task_id,
  stageId: r.stage_id,
  kind: r.kind,
  agentId: r.agent_id,
  model: r.model,
  effort: r.effort,
  command: r.command,
  cwd: r.cwd,
  status: r.status,
  exitCode: r.exit_code,
  errorClass: r.error_class,
  errorMessage: r.error_message,
  pid: r.pid,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  durationMs: r.duration_ms,
});

const toEvent = (r: Row): TaskEvent => ({
  id: r.id,
  taskId: r.task_id,
  type: r.type,
  stageId: r.stage_id,
  message: r.message,
  data: parse(r.data, {}),
  at: r.at,
});

const toDirective = (r: Row): Directive => ({
  id: r.id,
  taskId: r.task_id,
  text: r.text,
  status: r.status,
  pauseRequested: r.pause_requested === 1,
  createdAt: r.created_at,
  appliedAt: r.applied_at,
  appliedStageKey: r.applied_stage_key,
  scope: r.scope ?? 'CURRENT_TASK',
  kind: r.kind ?? 'instruction',
  state: r.state ?? 'active',
  rule: parse(r.normalized_rule, null),
  sourceMessageId: r.source_message_id ?? null,
  removedAt: r.removed_at ?? null,
  supersededBy: r.superseded_by ?? null,
});

const toArtifact = (r: Row): ArtifactRecord => ({
  id: r.id,
  taskId: r.task_id,
  stageId: r.stage_id,
  stageKey: r.stage_key,
  name: r.name,
  type: r.type,
  mime: r.mime,
  size: r.size,
  path: r.path,
  createdAt: r.created_at,
});

const toApproval = (r: Row): ApprovalRecord => ({
  id: r.id,
  taskId: r.task_id,
  stageId: r.stage_id,
  stageKey: r.stage_key,
  kind: r.kind,
  requestedBy: r.requested_by,
  action: r.action,
  command: r.command,
  permissionLevel: r.permission_level,
  risk: r.risk,
  reason: r.reason,
  riskExplanation: r.risk_explanation,
  environment: r.environment,
  confirmationPhrase: r.confirmation_phrase,
  status: r.status,
  note: r.note,
  createdAt: r.created_at,
  resolvedAt: r.resolved_at,
});

const toTestRun = (r: Row): TestRun => ({
  id: r.id,
  repositoryId: r.repository_id ?? null,
  taskId: r.task_id,
  stageId: r.stage_id,
  executionId: r.execution_id,
  name: r.name,
  kind: r.kind,
  command: r.command,
  status: r.status,
  exitCode: r.exit_code,
  durationMs: r.duration_ms,
  summary: r.summary,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  failures: parse(r.failures, null),
  classification: r.classification ?? null,
  treeId: r.tree_id ?? null,
  reusedFrom: r.reused_from ?? null,
  selection: r.selection === 'changed' || r.selection === 'full' ? r.selection : null,
});

/** A stored release setting that no longer validates reads as `none`: it never releases on a guess. */
function readRelease(raw: string | null | undefined): ReleaseConfig {
  const parsed = releaseConfigSchema.safeParse(parse(raw ?? null, { method: 'none' }));
  return parsed.success ? parsed.data : { method: 'none' };
}

const toRepository = (r: Row): RepositoryRecord => ({
  id: r.id,
  name: r.name,
  path: r.path,
  defaultWorkflowId: r.default_workflow_id,
  roleOverrides: parse(r.role_overrides, {}),
  commands: parse(r.commands, []),
  gitMode: r.git_mode,
  autoApproveUpToLevel: r.auto_approve_level,
  tooling: parse(r.tooling, []),
  lastTaskId: r.last_task_id,
  policyMode: r.policy_mode ?? null,
  runtime: repositoryRuntimeSchema.parse(parse(r.runtime, {})),
  preexistingFailures: r.preexisting_failures === 'block' ? 'block' : 'allow',
  testSelection: r.test_selection === 'changed' ? 'changed' : 'full',
  release: readRelease(r.release),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toAgent = (r: Row): AgentRecord => ({
  id: r.id,
  name: r.name,
  settings: {
    enabled: r.enabled === 1,
    executablePath: r.executable_path,
    loadUserConfig: r.load_user_config === 1,
  },
  detection: parse(r.detection, null),
  health: parse(r.health, null),
  capabilities: parse(r.capabilities, null),
  updatedAt: r.updated_at,
});

const toModel = (r: Row): ModelDescriptor => ({
  agentId: r.agent_id,
  modelId: r.model_id,
  label: r.label,
  efforts: parse(r.efforts, []),
  defaultEffort: r.default_effort,
  source: r.source,
  description: r.description,
});

const toSnapshot = (r: Row): SnapshotRecord => ({
  id: r.id,
  taskId: r.task_id,
  stageId: r.stage_id,
  kind: r.kind,
  branch: r.branch,
  head: r.head,
  files: parse(r.files, []),
  createdAt: r.created_at,
});

/** Column map for partial task updates: record field → [column, encoder]. */
const TASK_COLUMNS: Partial<Record<keyof TaskRecord, [string, (v: any) => unknown]>> = {
  title: ['title', (v) => v],
  description: ['description', (v) => v],
  workflowId: ['workflow_id', (v) => v],
  workflow: ['workflow_snapshot', json],
  mode: ['mode', (v) => v],
  status: ['status', (v) => v],
  currentStageKey: ['current_stage_key', (v) => v],
  currentStageId: ['current_stage_id', (v) => v],
  overrides: ['overrides', json],
  autoApproveUpToLevel: ['auto_approve_level', (v) => v],
  maxFixCycles: ['max_fix_cycles', (v) => v],
  fixCycles: ['fix_cycles', (v) => v],
  pauseRequested: ['pause_requested', (v) => (v ? 1 : 0)],
  pauseAfterStage: ['pause_after_stage', (v) => (v ? 1 : 0)],
  supervised: ['supervised', (v) => (v ? 1 : 0)],
  recoveryCycle: ['recovery_cycle', (v) => v],
  limits: ['limits', (v) => (v ? json(v) : null)],
  policyMode: ['policy_mode', (v) => v ?? null],
  extraCheckKinds: ['extra_check_kinds', json],
  blocker: ['blocker', (v) => (v ? json(v) : null)],
  lastEvent: ['last_event', (v) => (v ? json(v) : null)],
  finalStatus: ['final_status', (v) => v],
  git: ['git', json],
  attachments: ['attachments', json],
  promptVersions: ['prompt_versions', json],
  startedAt: ['started_at', (v) => v],
  finishedAt: ['finished_at', (v) => v],
};

/**
 * Fields whose change makes an earlier Chairman decision stale: the gateway
 * compares the version a decision was made against with the current one.
 */
const MATERIAL_FIELDS = new Set<keyof TaskRecord>([
  'status',
  'currentStageKey',
  'currentStageId',
  'overrides',
  'fixCycles',
  'maxFixCycles',
  'recoveryCycle',
  'pauseRequested',
  'pauseAfterStage',
  'workflow',
]);

const STAGE_COLUMNS: Partial<Record<keyof StageInstance, string>> = {
  status: 'status',
  agentId: 'agent_id',
  model: 'model',
  effort: 'effort',
  verdict: 'verdict',
  summary: 'summary',
  errorClass: 'error_class',
  errorMessage: 'error_message',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};

export class Store {
  constructor(readonly db: Db) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ----- settings ----------------------------------------------------------

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row ? parse<T>(row.value, undefined as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, json(value), now());
  }

  // ----- repositories -------------------------------------------------------

  listRepositories(): RepositoryRecord[] {
    return (this.db.prepare('SELECT * FROM repositories ORDER BY name COLLATE NOCASE').all() as Row[]).map(toRepository);
  }

  getRepository(id: string): RepositoryRecord | null {
    const row = this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as Row | undefined;
    return row ? toRepository(row) : null;
  }

  findRepositoryByPath(path: string): RepositoryRecord | null {
    const row = this.db.prepare('SELECT * FROM repositories WHERE lower(path) = lower(?)').get(path) as Row | undefined;
    return row ? toRepository(row) : null;
  }

  insertRepository(rec: RepositoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO repositories (id, name, path, default_workflow_id, role_overrides, commands, git_mode, auto_approve_level, tooling, last_task_id, created_at, updated_at, policy_mode, runtime, preexisting_failures, release, test_selection)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.name,
        rec.path,
        rec.defaultWorkflowId,
        json(rec.roleOverrides),
        json(rec.commands),
        rec.gitMode,
        rec.autoApproveUpToLevel,
        json(rec.tooling),
        rec.lastTaskId,
        rec.createdAt,
        rec.updatedAt,
        rec.policyMode,
        json(rec.runtime),
        rec.preexistingFailures ?? 'allow',
        json(rec.release ?? { method: 'none' }),
        rec.testSelection === 'changed' ? 'changed' : 'full',
      );
  }

  updateRepository(id: string, patch: Partial<RepositoryRecord>): void {
    const cols: Record<string, unknown> = {};
    if (patch.name !== undefined) cols.name = patch.name;
    if (patch.defaultWorkflowId !== undefined) cols.default_workflow_id = patch.defaultWorkflowId;
    if (patch.roleOverrides !== undefined) cols.role_overrides = json(patch.roleOverrides);
    if (patch.commands !== undefined) cols.commands = json(patch.commands);
    if (patch.gitMode !== undefined) cols.git_mode = patch.gitMode;
    if (patch.autoApproveUpToLevel !== undefined) cols.auto_approve_level = patch.autoApproveUpToLevel;
    if (patch.tooling !== undefined) cols.tooling = json(patch.tooling);
    if (patch.lastTaskId !== undefined) cols.last_task_id = patch.lastTaskId;
    if (patch.policyMode !== undefined) cols.policy_mode = patch.policyMode;
    if (patch.runtime !== undefined) cols.runtime = json(patch.runtime);
    if (patch.preexistingFailures !== undefined) cols.preexisting_failures = patch.preexistingFailures;
    if (patch.release !== undefined) cols.release = json(patch.release);
    if (patch.testSelection !== undefined) cols.test_selection = patch.testSelection === 'changed' ? 'changed' : 'full';
    cols.updated_at = now();
    const keys = Object.keys(cols);
    this.db.prepare(`UPDATE repositories SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k]), id);
  }

  deleteRepository(id: string): void {
    this.db.prepare('DELETE FROM repositories WHERE id = ?').run(id);
  }

  /** Tasks that work in this repository, as their primary or a linked repository. */
  countTasksForRepository(id: string): number {
    return (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM tasks WHERE repository_id = ? OR id IN (SELECT task_id FROM task_linked_repositories WHERE repository_id = ?)')
        .get(id, id) as Row
    ).n;
  }

  // ----- agents & models ---------------------------------------------------

  listAgents(): AgentRecord[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY rowid').all() as Row[]).map(toAgent);
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return row ? toAgent(row) : null;
  }

  ensureAgent(id: string, name: string): void {
    this.db
      .prepare('INSERT INTO agents (id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name')
      .run(id, name, now());
  }

  updateAgentSettings(id: string, settings: AgentSettings): void {
    this.db
      .prepare('UPDATE agents SET enabled = ?, executable_path = ?, load_user_config = ?, updated_at = ? WHERE id = ?')
      .run(settings.enabled ? 1 : 0, settings.executablePath, settings.loadUserConfig ? 1 : 0, now(), id);
  }

  updateAgentStatus(id: string, detection: AgentDetectionResult, health: AgentHealth, capabilities: AgentCapabilities): void {
    this.db
      .prepare('UPDATE agents SET detection = ?, health = ?, capabilities = ?, updated_at = ? WHERE id = ?')
      .run(json(detection), json(health), json(capabilities), now(), id);
  }

  listModels(agentId?: string): ModelDescriptor[] {
    const rows = agentId
      ? this.db.prepare('SELECT * FROM models WHERE agent_id = ? ORDER BY position, model_id').all(agentId)
      : this.db.prepare('SELECT * FROM models ORDER BY agent_id, position, model_id').all();
    return (rows as Row[]).map(toModel);
  }

  /** Replace discovered/builtin models for an agent; user-added models are kept. */
  replaceProviderModels(agentId: string, models: ModelDescriptor[]): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM models WHERE agent_id = ? AND source != 'user'").run(agentId);
      const insert = this.db.prepare(
        `INSERT INTO models (agent_id, model_id, label, efforts, default_effort, source, description, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id, model_id) DO NOTHING`,
      );
      models.forEach((m, i) => insert.run(agentId, m.modelId, m.label, json(m.efforts), m.defaultEffort, m.source, m.description, i));
    });
  }

  upsertUserModel(model: ModelDescriptor): void {
    this.db
      .prepare(
        `INSERT INTO models (agent_id, model_id, label, efforts, default_effort, source, description, position)
         VALUES (?, ?, ?, ?, NULL, 'user', NULL, 1000)
         ON CONFLICT(agent_id, model_id) DO UPDATE SET label = excluded.label, efforts = excluded.efforts`,
      )
      .run(model.agentId, model.modelId, model.label, json(model.efforts));
  }

  deleteUserModel(agentId: string, modelId: string): boolean {
    return this.db.prepare("DELETE FROM models WHERE agent_id = ? AND model_id = ? AND source = 'user'").run(agentId, modelId).changes > 0;
  }

  // ----- workflows ----------------------------------------------------------

  listWorkflows(): WorkflowProfile[] {
    const profiles = this.db.prepare('SELECT * FROM workflow_profiles ORDER BY builtin DESC, name COLLATE NOCASE').all() as Row[];
    const stages = this.db.prepare('SELECT * FROM workflow_stages ORDER BY profile_id, position').all() as Row[];
    return profiles.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      version: p.version,
      maxFixCycles: p.max_fix_cycles,
      builtin: p.builtin === 1,
      stages: stages.filter((s) => s.profile_id === p.id).map((s) => parse<StageDefinition>(s.definition, null as never)),
    }));
  }

  getWorkflow(id: string): WorkflowProfile | null {
    return this.listWorkflows().find((w) => w.id === id) ?? null;
  }

  saveWorkflow(profile: WorkflowProfile): void {
    this.transaction(() => {
      const ts = now();
      this.db
        .prepare(
          `INSERT INTO workflow_profiles (id, name, description, version, max_fix_cycles, builtin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, version = excluded.version,
             max_fix_cycles = excluded.max_fix_cycles, builtin = excluded.builtin, updated_at = excluded.updated_at`,
        )
        .run(profile.id, profile.name, profile.description, profile.version, profile.maxFixCycles, profile.builtin ? 1 : 0, ts, ts);
      this.db.prepare('DELETE FROM workflow_stages WHERE profile_id = ?').run(profile.id);
      const insert = this.db.prepare('INSERT INTO workflow_stages (profile_id, position, key, definition) VALUES (?, ?, ?, ?)');
      profile.stages.forEach((stage, i) => insert.run(profile.id, i, stage.key, json(stage)));
    });
  }

  deleteWorkflow(id: string): void {
    this.db.prepare('DELETE FROM workflow_profiles WHERE id = ?').run(id);
  }

  // ----- prompt templates --------------------------------------------------

  latestPrompt(role: Role): PromptTemplate | null {
    const row = this.db.prepare('SELECT * FROM prompt_templates WHERE role = ? ORDER BY version DESC LIMIT 1').get(role) as Row | undefined;
    return row ? { role: row.role, version: row.version, body: row.body, updatedAt: row.created_at, builtin: row.builtin === 1 } : null;
  }

  listLatestPrompts(): PromptTemplate[] {
    const rows = this.db
      .prepare('SELECT p.* FROM prompt_templates p JOIN (SELECT role, MAX(version) v FROM prompt_templates GROUP BY role) m ON m.role = p.role AND m.v = p.version ORDER BY p.role')
      .all() as Row[];
    return rows.map((row) => ({ role: row.role, version: row.version, body: row.body, updatedAt: row.created_at, builtin: row.builtin === 1 }));
  }

  insertPrompt(role: Role, body: string, builtin: boolean): PromptTemplate {
    const latest = this.latestPrompt(role);
    const version = (latest?.version ?? 0) + 1;
    const ts = now();
    this.db.prepare('INSERT INTO prompt_templates (role, version, body, builtin, created_at) VALUES (?, ?, ?, ?, ?)').run(role, version, body, builtin ? 1 : 0, ts);
    return { role, version, body, updatedAt: ts, builtin };
  }

  // ----- tasks ----------------------------------------------------------------

  nextTaskSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS s FROM tasks').get() as Row;
    return (row.s ?? 0) + 1;
  }

  insertTask(t: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, seq, title, description, repository_id, workflow_id, workflow_snapshot, mode, status, current_stage_key,
           current_stage_id, overrides, auto_approve_level, max_fix_cycles, fix_cycles, pause_requested, blocker, last_event, final_status,
           git, attachments, prompt_versions, created_at, started_at, finished_at, updated_at,
           supervised, recovery_cycle, limits, pause_after_stage, extra_check_kinds, version, policy_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.seq,
        t.title,
        t.description,
        t.repositoryId,
        t.workflowId,
        json(t.workflow),
        t.mode,
        t.status,
        t.currentStageKey,
        t.currentStageId,
        json(t.overrides),
        t.autoApproveUpToLevel,
        t.maxFixCycles,
        t.fixCycles,
        t.pauseRequested ? 1 : 0,
        t.blocker ? json(t.blocker) : null,
        t.lastEvent ? json(t.lastEvent) : null,
        t.finalStatus,
        json(t.git),
        json(t.attachments),
        json(t.promptVersions),
        t.createdAt,
        t.startedAt,
        t.finishedAt,
        t.updatedAt,
        t.supervised ? 1 : 0,
        t.recoveryCycle,
        t.limits ? json(t.limits) : null,
        t.pauseAfterStage ? 1 : 0,
        json(t.extraCheckKinds),
        t.version,
        t.policyMode,
      );
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? toTask(row) : null;
  }

  updateTask(id: string, patch: Partial<TaskRecord>): TaskRecord {
    const sets: string[] = [];
    const values: unknown[] = [];
    let material = false;
    for (const [field, value] of Object.entries(patch)) {
      const column = TASK_COLUMNS[field as keyof TaskRecord];
      if (!column) continue;
      sets.push(`${column[0]} = ?`);
      values.push(column[1](value));
      if (MATERIAL_FIELDS.has(field as keyof TaskRecord)) material = true;
    }
    if (material) sets.push('version = version + 1');
    sets.push('updated_at = ?');
    values.push(now());
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.getTask(id)!;
  }

  listTasks(filter: { statuses?: TaskStatus[]; repositoryId?: string; limit?: number; before?: string; search?: string } = {}): TaskRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
      params.push(...filter.statuses);
    }
    if (filter.repositoryId) {
      // A task works in its primary repository and any linked ones.
      where.push('(repository_id = ? OR id IN (SELECT task_id FROM task_linked_repositories WHERE repository_id = ?))');
      params.push(filter.repositoryId, filter.repositoryId);
    }
    if (filter.before) {
      where.push('updated_at < ?');
      params.push(filter.before);
    }
    if (filter.search) {
      where.push('(title LIKE ? OR id LIKE ? OR description LIKE ?)');
      const like = `%${filter.search.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like, like);
    }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC, seq DESC LIMIT ?`;
    return (this.db.prepare(sql.replace(/LIKE \?/g, "LIKE ? ESCAPE '\\'")).all(...params, filter.limit ?? 50) as Row[]).map(toTask);
  }

  // ----- linked repositories (multi-repository tasks) ----------------------

  insertLinkedRepositories(rows: LinkedRepositoryRecord[]): void {
    const insert = this.db.prepare('INSERT INTO task_linked_repositories (task_id, repository_id, position, folder, git) VALUES (?, ?, ?, ?, ?)');
    this.transaction(() => {
      for (const r of rows) insert.run(r.taskId, r.repositoryId, r.position, r.folder, json(r.git));
    });
  }

  listLinkedRepositories(taskId: string): LinkedRepositoryRecord[] {
    const rows = this.db.prepare('SELECT * FROM task_linked_repositories WHERE task_id = ? ORDER BY position').all(taskId) as Row[];
    return rows.map((r) => ({ taskId: r.task_id, repositoryId: r.repository_id, position: r.position, folder: r.folder, git: { ...EMPTY_GIT, ...parse(r.git, {}) } }));
  }

  updateLinkedRepositoryGit(taskId: string, repositoryId: string, git: TaskGitRecord): void {
    this.db.prepare('UPDATE task_linked_repositories SET git = ? WHERE task_id = ? AND repository_id = ?').run(json(git), taskId, repositoryId);
    // Like a change of tasks.git: not material (no version bump, which would make pending decisions and remote commands stale).
    this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), taskId);
  }

  countTasksByStatus(): Record<string, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as Row[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  countCompletedSince(since: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'COMPLETED' AND finished_at >= ?").get(since) as Row).n;
  }

  // ----- stages -------------------------------------------------------------

  insertStage(stage: StageInstance): void {
    this.db
      .prepare(
        `INSERT INTO task_stages (id, task_id, stage_key, name, role, kind, status, agent_id, model, effort, permission_level, attempt, cycle,
           verdict, summary, error_class, error_message, started_at, finished_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stage.id,
        stage.taskId,
        stage.stageKey,
        stage.name,
        stage.role,
        stage.kind,
        stage.status,
        stage.agentId,
        stage.model,
        stage.effort,
        stage.permissionLevel,
        stage.attempt,
        stage.cycle,
        stage.verdict,
        stage.summary,
        stage.errorClass,
        stage.errorMessage,
        stage.startedAt,
        stage.finishedAt,
        stage.createdAt,
      );
  }

  updateStage(id: string, patch: Partial<StageInstance>): StageInstance {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [field, value] of Object.entries(patch)) {
      const column = STAGE_COLUMNS[field as keyof StageInstance];
      if (!column) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (sets.length) this.db.prepare(`UPDATE task_stages SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.getStage(id)!;
  }

  getStage(id: string): StageInstance | null {
    const row = this.db.prepare('SELECT * FROM task_stages WHERE id = ?').get(id) as Row | undefined;
    return row ? toStage(row) : null;
  }

  listStages(taskId: string): StageInstance[] {
    return (this.db.prepare('SELECT * FROM task_stages WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as Row[]).map(toStage);
  }

  latestStage(taskId: string, stageKey: string): StageInstance | null {
    const row = this.db
      .prepare('SELECT * FROM task_stages WHERE task_id = ? AND stage_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(taskId, stageKey) as Row | undefined;
    return row ? toStage(row) : null;
  }

  latestStageByRole(taskId: string, role: Role, statuses: StageStatus[] = ['SUCCESS']): StageInstance | null {
    const row = this.db
      .prepare(
        `SELECT * FROM task_stages WHERE task_id = ? AND role = ? AND status IN (${statuses.map(() => '?').join(',')})
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId, role, ...statuses) as Row | undefined;
    return row ? toStage(row) : null;
  }

  stagesWithStatus(statuses: StageStatus[]): StageInstance[] {
    return (this.db.prepare(`SELECT * FROM task_stages WHERE status IN (${statuses.map(() => '?').join(',')})`).all(...statuses) as Row[]).map(toStage);
  }

  // ----- executions & logs -------------------------------------------------

  insertExecution(e: Execution): void {
    this.db
      .prepare(
        `INSERT INTO executions (id, task_id, stage_id, kind, agent_id, model, effort, command, cwd, status, exit_code, error_class,
           error_message, pid, started_at, finished_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.id, e.taskId, e.stageId, e.kind, e.agentId, e.model, e.effort, e.command, e.cwd, e.status, e.exitCode, e.errorClass, e.errorMessage, e.pid, e.startedAt, e.finishedAt, e.durationMs);
  }

  updateExecution(id: string, patch: { status?: ExecutionStatus; exitCode?: number | null; errorClass?: ErrorClass | null; errorMessage?: string | null; pid?: number | null; command?: string; finishedAt?: string | null; durationMs?: number | null }): Execution {
    const map: Record<string, string> = {
      status: 'status',
      exitCode: 'exit_code',
      errorClass: 'error_class',
      errorMessage: 'error_message',
      pid: 'pid',
      command: 'command',
      finishedAt: 'finished_at',
      durationMs: 'duration_ms',
    };
    const entries = Object.entries(patch).filter(([k]) => map[k]);
    if (entries.length) {
      this.db.prepare(`UPDATE executions SET ${entries.map(([k]) => `${map[k]} = ?`).join(', ')} WHERE id = ?`).run(...entries.map(([, v]) => v), id);
    }
    return this.getExecution(id)!;
  }

  getExecution(id: string): Execution | null {
    const row = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(id) as Row | undefined;
    return row ? toExecution(row) : null;
  }

  listExecutions(taskId: string): Execution[] {
    return (this.db.prepare('SELECT * FROM executions WHERE task_id = ? ORDER BY started_at, rowid').all(taskId) as Row[]).map(toExecution);
  }

  executionsWithStatus(status: ExecutionStatus): Execution[] {
    return (this.db.prepare('SELECT * FROM executions WHERE status = ?').all(status) as Row[]).map(toExecution);
  }

  insertLogLines(lines: LogLine[]): void {
    if (!lines.length) return;
    const insert = this.db.prepare('INSERT INTO execution_logs (execution_id, seq, stream, text, at) VALUES (?, ?, ?, ?, ?)');
    this.transaction(() => {
      for (const l of lines) insert.run(l.executionId, l.seq, l.stream, l.text, l.at);
    });
  }

  listLogLines(executionId: string, options: { after?: number; limit?: number; stream?: string; search?: string } = {}): LogLine[] {
    const where = ['execution_id = ?', 'seq > ?'];
    const params: unknown[] = [executionId, options.after ?? -1];
    if (options.stream) {
      where.push('stream = ?');
      params.push(options.stream);
    }
    if (options.search) {
      where.push("text LIKE ? ESCAPE '\\'");
      params.push(`%${options.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    }
    const rows = this.db
      .prepare(`SELECT * FROM execution_logs WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`)
      .all(...params, Math.min(options.limit ?? 1000, 5000)) as Row[];
    return rows.map((r) => ({ executionId: r.execution_id, seq: r.seq, stream: r.stream, text: r.text, at: r.at }));
  }

  tailLogLines(executionId: string, count: number): LogLine[] {
    const rows = this.db
      .prepare('SELECT * FROM (SELECT * FROM execution_logs WHERE execution_id = ? ORDER BY seq DESC LIMIT ?) ORDER BY seq')
      .all(executionId, count) as Row[];
    return rows.map((r) => ({ executionId: r.execution_id, seq: r.seq, stream: r.stream, text: r.text, at: r.at }));
  }

  // ----- events -------------------------------------------------------------

  insertEvent(e: Omit<TaskEvent, 'id'>): TaskEvent {
    const info = this.db
      .prepare('INSERT INTO task_events (task_id, type, stage_id, message, data, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.taskId, e.type, e.stageId, e.message, json(e.data), e.at);
    return { ...e, id: Number(info.lastInsertRowid) };
  }

  listEvents(taskId: string, options: { after?: number; limit?: number } = {}): TaskEvent[] {
    return (
      this.db.prepare('SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id LIMIT ?').all(taskId, options.after ?? 0, Math.min(options.limit ?? 500, 2000)) as Row[]
    ).map(toEvent);
  }

  /** A task's events of some types, oldest first (at most `limit`). */
  eventsOfType(taskId: string, types: EventType[], limit = 500): TaskEvent[] {
    return (
      this.db
        .prepare(`SELECT * FROM task_events WHERE task_id = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY id LIMIT ?`)
        .all(taskId, ...types, limit) as Row[]
    ).map(toEvent);
  }

  lastEventOfType(taskId: string, types: EventType[]): TaskEvent | null {
    const row = this.db
      .prepare(`SELECT * FROM task_events WHERE task_id = ? AND type IN (${types.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`)
      .get(taskId, ...types) as Row | undefined;
    return row ? toEvent(row) : null;
  }

  // ----- directives ----------------------------------------------------------

  insertDirective(d: Directive): void {
    this.db
      .prepare(
        `INSERT INTO task_directives (id, task_id, text, status, pause_requested, created_at, applied_at, applied_stage_key,
           scope, kind, state, normalized_rule, source_message_id, removed_at, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.id,
        d.taskId,
        d.text,
        d.status,
        d.pauseRequested ? 1 : 0,
        d.createdAt,
        d.appliedAt,
        d.appliedStageKey,
        d.scope,
        d.kind,
        d.state,
        d.rule ? json(d.rule) : null,
        d.sourceMessageId,
        d.removedAt,
        d.supersededBy,
      );
  }

  getDirective(id: string): Directive | null {
    const row = this.db.prepare('SELECT * FROM task_directives WHERE id = ?').get(id) as Row | undefined;
    return row ? toDirective(row) : null;
  }

  /** End a directive's life: it no longer reaches any stage. */
  retireDirective(id: string, state: 'removed' | 'superseded', supersededBy: string | null = null): Directive {
    this.db.prepare('UPDATE task_directives SET state = ?, removed_at = ?, superseded_by = ? WHERE id = ?').run(state, now(), supersededBy, id);
    return this.getDirective(id)!;
  }

  listDirectives(taskId: string): Directive[] {
    return (this.db.prepare('SELECT * FROM task_directives WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as Row[]).map(toDirective);
  }

  markDirectivesApplied(taskId: string, stageKey: string): Directive[] {
    const queued = this.listDirectives(taskId).filter((d) => d.status === 'queued' && d.state === 'active');
    const ts = now();
    this.db
      .prepare("UPDATE task_directives SET status = 'applied', applied_at = ?, applied_stage_key = ? WHERE task_id = ? AND status = 'queued' AND state = 'active'")
      .run(ts, stageKey, taskId);
    return queued.map((d) => ({ ...d, status: 'applied', appliedAt: ts, appliedStageKey: stageKey }));
  }

  // ----- artifacts -------------------------------------------------------------

  insertArtifact(a: ArtifactRecord): void {
    this.db
      .prepare('INSERT INTO task_artifacts (id, task_id, stage_id, stage_key, name, type, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.taskId, a.stageId, a.stageKey, a.name, a.type, a.mime, a.size, a.path, a.createdAt);
  }

  listArtifacts(taskId: string): ArtifactRecord[] {
    return (this.db.prepare('SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at, rowid').all(taskId) as Row[]).map(toArtifact);
  }

  getArtifact(id: string): ArtifactRecord | null {
    const row = this.db.prepare('SELECT * FROM task_artifacts WHERE id = ?').get(id) as Row | undefined;
    return row ? toArtifact(row) : null;
  }

  latestArtifactOfType(taskId: string, type: ArtifactType): ArtifactRecord | null {
    const row = this.db
      .prepare('SELECT * FROM task_artifacts WHERE task_id = ? AND type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(taskId, type) as Row | undefined;
    return row ? toArtifact(row) : null;
  }

  // ----- approvals -------------------------------------------------------------

  insertApproval(a: ApprovalRecord): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, task_id, stage_id, stage_key, kind, requested_by, action, command, permission_level, risk, reason,
           risk_explanation, environment, confirmation_phrase, status, note, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.taskId, a.stageId, a.stageKey, a.kind, a.requestedBy, a.action, a.command, a.permissionLevel, a.risk, a.reason, a.riskExplanation, a.environment, a.confirmationPhrase, a.status, a.note, a.createdAt, a.resolvedAt);
  }

  getApproval(id: string): ApprovalRecord | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined;
    return row ? toApproval(row) : null;
  }

  resolveApproval(id: string, status: ApprovalStatus, note: string | null): ApprovalRecord {
    this.db.prepare('UPDATE approvals SET status = ?, note = ?, resolved_at = ? WHERE id = ?').run(status, note, now(), id);
    return this.getApproval(id)!;
  }

  listApprovals(filter: { status?: ApprovalStatus; taskId?: string; limit?: number } = {}): ApprovalRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.taskId) {
      where.push('task_id = ?');
      params.push(filter.taskId);
    }
    return (
      this.db
        .prepare(`SELECT * FROM approvals ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
        .all(...params, filter.limit ?? 200) as Row[]
    ).map(toApproval);
  }

  /** Most recent approval for a gate, optionally pinned to one stage instance or command. */
  findApproval(taskId: string, kind: ApprovalKind, match: { stageKey?: string; stageId?: string; command?: string }): ApprovalRecord | null {
    const where = ['task_id = ?', 'kind = ?'];
    const params: unknown[] = [taskId, kind];
    if (match.stageKey !== undefined) {
      where.push('stage_key = ?');
      params.push(match.stageKey);
    }
    if (match.stageId !== undefined) {
      where.push('stage_id = ?');
      params.push(match.stageId);
    }
    if (match.command !== undefined) {
      where.push('command = ?');
      params.push(match.command);
    }
    const row = this.db.prepare(`SELECT * FROM approvals WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(...params) as Row | undefined;
    return row ? toApproval(row) : null;
  }

  cancelPendingApprovals(taskId: string): ApprovalRecord[] {
    const pending = this.listApprovals({ taskId, status: 'pending' });
    for (const a of pending) this.resolveApproval(a.id, 'cancelled', 'Task no longer waiting');
    return pending.map((a) => this.getApproval(a.id)!);
  }

  // ----- git snapshots ----------------------------------------------------------

  insertSnapshot(s: SnapshotRecord): void {
    this.db
      .prepare('INSERT INTO git_snapshots (id, task_id, stage_id, kind, branch, head, files, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.id, s.taskId, s.stageId, s.kind, s.branch, s.head, json(s.files), s.createdAt);
  }

  getSnapshot(id: string): SnapshotRecord | null {
    const row = this.db.prepare('SELECT * FROM git_snapshots WHERE id = ?').get(id) as Row | undefined;
    return row ? toSnapshot(row) : null;
  }

  // ----- test runs ----------------------------------------------------------

  insertTestRun(t: TestRun): void {
    this.db
      .prepare(
        `INSERT INTO test_runs (id, task_id, stage_id, execution_id, name, kind, command, status, exit_code, duration_ms, summary, started_at, finished_at, repository_id, failures, classification, tree_id, reused_from, selection)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id, t.taskId, t.stageId, t.executionId, t.name, t.kind, t.command, t.status, t.exitCode, t.durationMs, t.summary, t.startedAt, t.finishedAt, t.repositoryId ?? null,
        t.failures ? json(t.failures) : null, t.classification ?? null, t.treeId ?? null, t.reusedFrom ?? null, t.selection ?? null,
      );
  }

  updateTestRun(id: string, patch: Partial<Pick<TestRun, 'status' | 'exitCode' | 'durationMs' | 'summary' | 'finishedAt' | 'executionId' | 'startedAt' | 'failures' | 'classification' | 'treeId' | 'reusedFrom' | 'selection'>>): TestRun {
    const map: Record<string, string> = {
      status: 'status',
      exitCode: 'exit_code',
      durationMs: 'duration_ms',
      summary: 'summary',
      finishedAt: 'finished_at',
      executionId: 'execution_id',
      startedAt: 'started_at',
      failures: 'failures',
      classification: 'classification',
      treeId: 'tree_id',
      reusedFrom: 'reused_from',
      selection: 'selection',
    };
    const entries = Object.entries(patch)
      .filter(([k]) => map[k])
      .map(([k, v]): [string, unknown] => [k, k === 'failures' && v ? json(v) : v]);
    if (entries.length) this.db.prepare(`UPDATE test_runs SET ${entries.map(([k]) => `${map[k]} = ?`).join(', ')} WHERE id = ?`).run(...entries.map(([, v]) => v), id);
    return toTestRun(this.db.prepare('SELECT * FROM test_runs WHERE id = ?').get(id) as Row);
  }

  listTestRuns(taskId: string, stageId?: string): TestRun[] {
    const rows = stageId
      ? this.db.prepare('SELECT * FROM test_runs WHERE task_id = ? AND stage_id = ? ORDER BY rowid').all(taskId, stageId)
      : this.db.prepare('SELECT * FROM test_runs WHERE task_id = ? ORDER BY rowid').all(taskId);
    return (rows as Row[]).map(toTestRun);
  }

  testRunsWithStatus(status: TestRunStatus): TestRun[] {
    return (this.db.prepare('SELECT * FROM test_runs WHERE status = ?').all(status) as Row[]).map(toTestRun);
  }

  /** A passing run of the same command on the same files earlier in this task (§3.E), or null. */
  findReusableRun(taskId: string, treeId: string, command: string, repositoryId: string | null): TestRun | null {
    const row = this.db
      .prepare(
        `SELECT * FROM test_runs WHERE task_id = ? AND tree_id = ? AND command = ? AND status = 'passed' AND IFNULL(repository_id, '') = ?
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(taskId, treeId, command, repositoryId ?? '') as Row | undefined;
    return row ? toTestRun(row) : null;
  }

  // ----- baseline checks (AUTOPILOT_GATES_PLAN §3.B) ---------------------------

  getBaselineCheck(key: BaselineCheckKey): BaselineCheckRecord | null {
    const row = this.db
      .prepare('SELECT * FROM baseline_checks WHERE repository_id = ? AND baseline_commit = ? AND command_id = ? AND command_sha = ?')
      .get(key.repositoryId, key.baselineCommit, key.commandId, key.commandSha) as Row | undefined;
    return row
      ? { ...key, id: row.id, status: row.status, summary: row.summary, failures: parse(row.failures, []), durationMs: row.duration_ms, createdAt: row.created_at }
      : null;
  }

  saveBaselineCheck(rec: BaselineCheckRecord): void {
    this.db
      .prepare(
        `INSERT INTO baseline_checks (id, repository_id, baseline_commit, command_id, command_sha, status, summary, failures, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repository_id, baseline_commit, command_id, command_sha) DO UPDATE SET
           status = excluded.status, summary = excluded.summary, failures = excluded.failures, duration_ms = excluded.duration_ms, created_at = excluded.created_at`,
      )
      .run(rec.id, rec.repositoryId, rec.baselineCommit, rec.commandId, rec.commandSha, rec.status, rec.summary, json(rec.failures), rec.durationMs, rec.createdAt);
  }
}

export type { CommandKind, CommandRisk, DirectiveKind, DirectiveScope, StageKind };
