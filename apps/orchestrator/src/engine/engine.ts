import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readdir, rmdir } from 'node:fs/promises';
import { changesSince, createTaskBranch, currentBranch, deleteBranchIfAt, diffSince, headCommit, isGitRepository, removeWorktree, snapshot, taskBranchName, taskIdFromBranch, type GitSnapshot } from '@acc/git';
import { redact } from '@acc/security';
import {
  COMPLETE,
  ERROR_CLASS_LABEL,
  PERMISSION_LEVEL_INFO,
  ROLE_LABEL,
  TERMINAL_TASK_STATUSES,
  createTaskSchema,
  isReadOnlyWorkflow,
  type CommandKind,
  type CreateTaskInput,
  type Directive,
  type DirectiveKind,
  type DirectiveRule,
  type DirectiveScope,
  type PartialAssignment,
  type StageDefinition,
  type StageInstance,
  type ChangedFile,
  type PermissionLevel,
  type TaskBlocker,
  type TaskDetail,
  type TaskStatus,
} from '@acc/shared';
import type { z } from 'zod';
import type { Bus } from '../bus.js';
import type { AgentRegistry } from '../services/agents.js';
import type { ArtifactService } from '../services/artifacts.js';
import type { RepositoryService } from '../services/repositories.js';
import type { RepositoryCoordinator } from '../services/repository-coordinator.js';
import type { SettingsService } from '../services/settings.js';
import type { WorkflowService } from '../services/workflows.js';
import { newId, now, type Store, type TaskRecord } from '../store/store.js';
import { ApprovalGate } from './approvals.js';
import type { BaselineChecks } from './baseline-checks.js';
import { buildFinalReport, latestOperatorItems } from './report.js';
import { taskTimeBreakdown, timeBreakdownLines } from './time-breakdown.js';
import { Publisher } from './publisher.js';
import { skipsForLackOfCommands, StageRunners, type RedirectPlan, type RunControl, type StageOutcome, type StopReason } from './runners.js';
import type { SupervisorHooks } from './supervision.js';
import type { EngineTooling } from './tooling.js';
import { inFolder, isMultiRepository, strictestPolicy, taskRepositories, taskRepositoryIds, workspaceFolders, type TaskRepository } from './task-repositories.js';
import { taskWorkdir } from './workdir.js';
import type { ContextBuilder } from './context.js';
import { ReleaseService, type Probe } from '../release/service.js';
import type { TaskViews } from './views.js';

export class EngineError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'INVALID_STATE' | 'INVALID_INPUT' | 'CONFIRMATION_REQUIRED',
  ) {
    super(message);
  }
}

export interface EngineDeps {
  store: Store;
  bus: Bus;
  views: TaskViews;
  agents: AgentRegistry;
  repositories: RepositoryService;
  workflows: WorkflowService;
  artifacts: ArtifactService;
  context: ContextBuilder;
  settings: SettingsService;
  /** Shared with Source Control: stages that edit files never overlap a Git mutation. */
  coordinator: RepositoryCoordinator;
  /** The tool layer: sessions, repairs, verification, worktrees, cleanup (docs/plans/tool-layer-v2). */
  tooling: EngineTooling;
  /** Failed checks compared with the task's baseline commit (AUTOPILOT_GATES_PLAN §3.B). */
  baselines: BaselineChecks;
  baseEnv?: NodeJS.ProcessEnv;
  /** Release proof reads: a stand-in for the live site in tests, and the poll interval. */
  release?: { probe?: Probe; pollSeconds?: number };
}

/** Statuses from which a user may resume or retry. */
const RESUMABLE: readonly TaskStatus[] = ['PAUSED', 'INTERRUPTED', 'WAITING_FOR_USAGE_RESET', 'WAITING_FOR_USER', 'FAILED'];

/**
 * The workflow engine (PLAN §12, §22). The database is the source of truth:
 * every transition is persisted before the next step runs, so a restart can
 * always reconstruct where a task was. One loop runs per active task, and at
 * most one task works in a repository at a time.
 */
export class TaskEngine {
  private readonly runners = new Map<string, { control: RunControl; done: Promise<void> }>();
  readonly publisher: Publisher;
  readonly approvals: ApprovalGate;
  private readonly stages: StageRunners;
  /** Sending tested work live (docs/plans/RELEASE_STAGE_PLAN.md). */
  readonly release: ReleaseService;
  private scheduling = false;
  private rescheduleRequested = false;
  private shuttingDown = false;
  /** Drain mode (AUTOPILOT_GATES_PLAN §3.G): every task stops at its next stage boundary, then `onDrained` runs. */
  private draining: { onDrained: () => void } | null = null;
  private supervisor: SupervisorHooks | null = null;

  constructor(private readonly d: EngineDeps) {
    this.publisher = new Publisher(d.store, d.bus, d.views);
    this.approvals = new ApprovalGate(d.store, d.bus, d.views, this.publisher);
    this.release = new ReleaseService({
      store: d.store,
      bus: d.bus,
      views: d.views,
      publisher: this.publisher,
      approvals: this.approvals,
      coordinator: d.coordinator,
      repositories: d.repositories,
      artifacts: d.artifacts,
      tooling: d.tooling,
      probe: d.release?.probe,
      pollSeconds: d.release?.pollSeconds,
    });
    this.stages = new StageRunners({
      store: d.store,
      bus: d.bus,
      publisher: this.publisher,
      agents: d.agents,
      artifacts: d.artifacts,
      context: d.context,
      settings: d.settings,
      approvals: this.approvals,
      baseEnv: d.baseEnv ?? process.env,
      tooling: d.tooling,
      baselines: d.baselines,
      release: this.release,
    });
    d.tooling.attachPublisher(this.publisher);
  }

  /** The Chairman registers here after construction (it needs the engine too). */
  attachSupervisor(hooks: SupervisorHooks): void {
    this.supervisor = hooks;
  }

  private supervises(task: TaskRecord): boolean {
    return task.supervised && this.supervisor !== null;
  }

  // ===========================================================================
  // Queries
  // ===========================================================================

  task(id: string): TaskRecord {
    const task = this.d.store.getTask(id);
    if (!task) throw new EngineError(`Task ${id} not found`, 'NOT_FOUND');
    return task;
  }

  detail(id: string): TaskDetail {
    return this.d.views.detail(this.task(id));
  }

  isRunning(id: string): boolean {
    return this.runners.has(id);
  }

  /** Tasks whose loop is working now, with the stage each is in: ids and names only, never content. */
  runningStages(): Array<{ taskId: string; stage: string | null }> {
    return [...this.runners.keys()].map((taskId) => {
      const task = this.d.store.getTask(taskId);
      const stage = task?.currentStageId ? this.d.store.getStage(task.currentStageId) : null;
      return { taskId, stage: stage?.name ?? null };
    });
  }

  get isDraining(): boolean {
    return this.draining !== null;
  }

  /**
   * Stop starting work and let each running task stop at its next stage
   * boundary, marked INTERRUPTED so it resumes after the restart; then call
   * `onDrained` (once). A stage that never ends can still be forced.
   */
  drain(onDrained: () => void): void {
    if (this.draining) {
      const previous = this.draining.onDrained;
      this.draining.onDrained = () => {
        previous();
        onDrained();
      };
    } else {
      this.draining = { onDrained };
    }
    for (const id of this.runners.keys()) this.publisher.event(id, 'TASK_PAUSED', 'The orchestrator is restarting: this task stops after the current stage and resumes when it is back');
    this.checkDrained();
  }

  private checkDrained(): void {
    if (!this.draining || this.runners.size) return;
    const { onDrained } = this.draining;
    this.draining.onDrained = () => undefined;
    onDrained();
  }

  // ===========================================================================
  // Commands
  // ===========================================================================

  async createTask(raw: CreateTaskInput): Promise<TaskDetail> {
    const input = createTaskSchema.parse(raw) as z.output<typeof createTaskSchema>;
    const repo = this.d.repositories.record(input.repositoryId);
    const linkedRepos = (input.linkedRepositoryIds ?? []).map((id) => this.d.repositories.record(id));
    const workflow = this.d.workflows.get(input.workflowId);
    const settings = this.d.settings.get();
    // A task across repositories works in isolated worktrees of each: every one needs Git and a first commit.
    if (linkedRepos.length) await this.checkWorkspaceRepositories([repo, ...linkedRepos]);
    const allRepos = [repo, ...linkedRepos];
    const folders = linkedRepos.length ? workspaceFolders(allRepos.map((r) => r.name)) : [];
    for (const assignment of [...Object.values(input.overrides?.roles ?? {}), ...Object.values(input.overrides?.stages ?? {})]) {
      if (assignment?.agentId && !this.d.agents.has(assignment.agentId)) {
        throw new EngineError(`Unknown agent "${assignment.agentId}"`, 'INVALID_INPUT');
      }
    }
    for (const key of Object.keys(input.overrides?.stages ?? {})) {
      if (!workflow.stages.some((s) => s.key === key)) throw new EngineError(`Workflow has no stage "${key}"`, 'INVALID_INPUT');
    }

    const seq = this.d.store.nextTaskSeq();
    const id = `TASK-${String(seq).padStart(4, '0')}`;
    const title = input.title?.trim() || deriveTitle(input.description);
    const ts = now();
    const supervised = input.supervised ?? (input.mode === 'autopilot' && settings.chairman.enabled);
    const task: TaskRecord = {
      id,
      seq,
      title,
      description: input.description,
      repositoryId: repo.id,
      workflowId: workflow.id,
      workflow,
      mode: input.mode,
      status: 'DRAFT',
      currentStageKey: workflow.stages[0]!.key,
      currentStageId: null,
      overrides: input.overrides ?? { roles: {}, stages: {} },
      // Across repositories the task gets the most restrictive of their defaults.
      autoApproveUpToLevel: input.autoApproveUpToLevel ?? (Math.min(...allRepos.map((r) => r.autoApproveUpToLevel ?? settings.autoApproveUpToLevel)) as PermissionLevel),
      maxFixCycles: input.maxFixCycles ?? workflow.maxFixCycles,
      fixCycles: 0,
      pauseRequested: false,
      pauseAfterStage: false,
      supervised,
      recoveryCycle: 0,
      limits: supervised
        ? { maxRecoveryCycles: settings.chairman.maxRecoveryCycles, maxRuntimeMinutes: settings.chairman.maxTaskRuntimeMinutes, maxAgentRuns: settings.chairman.maxAgentRuns }
        : null,
      extraCheckKinds: [],
      policyMode: input.policyMode ?? strictestPolicy(allRepos.map((r) => r.policyMode ?? settings.execution.policyMode)),
      version: 0,
      blocker: null,
      lastEvent: null,
      finalStatus: null,
      git: {
        baselineCommit: null,
        baselineBranch: null,
        taskBranch: null,
        preexistingChanges: [],
        commits: [],
        baselineSnapshotId: null,
        worktreePath: null,
        isolated: linkedRepos.length ? true : (input.worktree ?? repo.gitMode === 'worktree'),
        ...(linkedRepos.length ? { folder: folders[0]! } : {}),
      },
      attachments: [],
      promptVersions: {},
      createdAt: ts,
      startedAt: null,
      finishedAt: null,
      updatedAt: ts,
    };
    // The task and its linked repositories are written together, or not at all.
    this.d.store.transaction(() => {
      this.d.store.insertTask(task);
      if (linkedRepos.length) {
        const git = { baselineCommit: null, baselineBranch: null, taskBranch: null, preexistingChanges: [], commits: [], baselineSnapshotId: null, worktreePath: null, isolated: true };
        this.d.store.insertLinkedRepositories(linkedRepos.map((r, i) => ({ taskId: id, repositoryId: r.id, position: i + 1, folder: folders[i + 1]!, git })));
      }
    });
    for (const r of allRepos) this.d.store.updateRepository(r.id, { lastTaskId: id });
    this.supervisor?.onTaskCreated(task);

    if (input.attachments?.length) {
      const dir = path.join(this.d.artifacts.taskDir(id), 'attachments');
      mkdirSync(dir, { recursive: true });
      const attachments = [];
      for (const att of input.attachments) {
        const name = path.basename(att.name).replace(/[^A-Za-z0-9._-]+/g, '-') || 'attachment';
        const file = path.join(dir, name);
        const buffer = Buffer.from(att.contentBase64, 'base64');
        await writeFile(file, buffer);
        attachments.push({ name, path: file, size: buffer.length });
      }
      this.d.store.updateTask(id, { attachments });
    }
    await this.d.artifacts.write(id, { name: 'request.md', type: 'request', content: `# ${title}\n\n${input.description}\n` });
    this.publisher.event(id, 'TASK_CREATED', `Task created in ${allRepos.map((r) => r.name).join(', ')} · ${workflow.name} · ${input.mode === 'discuss' ? 'Discuss First' : 'Autopilot'}`);
    if (input.start) await this.start(id);
    return this.detail(id);
  }

  updateDraft(id: string, patch: { title?: string; description?: string; workflowId?: string; mode?: TaskRecord['mode']; overrides?: TaskRecord['overrides'] }): TaskDetail {
    const task = this.task(id);
    if (task.status !== 'DRAFT') throw new EngineError('Only draft tasks can be edited', 'INVALID_STATE');
    const update: Partial<TaskRecord> = { ...patch };
    if (patch.workflowId && patch.workflowId !== task.workflowId) {
      const workflow = this.d.workflows.get(patch.workflowId);
      update.workflow = workflow;
      update.currentStageKey = workflow.stages[0]!.key;
      update.maxFixCycles = workflow.maxFixCycles;
    }
    this.publisher.updateTask(id, update);
    return this.detail(id);
  }

  async start(id: string): Promise<void> {
    const task = this.task(id);
    if (task.status !== 'DRAFT') throw new EngineError(`Task is ${task.status}, not a draft`, 'INVALID_STATE');
    this.publisher.updateTask(id, { status: 'QUEUED' });
    this.publisher.event(id, 'TASK_QUEUED', 'Task queued');
    this.schedule();
  }

  async pause(id: string): Promise<void> {
    const task = this.task(id);
    if (task.status === 'QUEUED') {
      this.publisher.updateTask(id, { status: 'PAUSED', blocker: null });
      this.publisher.event(id, 'TASK_PAUSED', 'Task paused before it started');
      return;
    }
    if (task.status !== 'RUNNING') throw new EngineError(`A ${task.status.toLowerCase()} task cannot be paused`, 'INVALID_STATE');
    this.publisher.updateTask(id, { pauseRequested: true });
    await this.stop(id, 'pause');
  }

  async resume(id: string): Promise<void> {
    const task = this.task(id);
    if (!RESUMABLE.includes(task.status)) throw new EngineError(`A ${task.status.toLowerCase()} task cannot be resumed`, 'INVALID_STATE');
    if (task.blocker?.kind === 'approval') throw new EngineError('This task is waiting for an approval. Review it in Approvals.', 'INVALID_STATE');
    if (this.supervises(task)) this.supervisor!.onResume(task);
    const patch: Partial<TaskRecord> = { status: 'QUEUED', blocker: null, pauseRequested: false, pauseAfterStage: false };
    if (task.blocker?.kind === 'limit' && task.limits && this.supervisor) {
      // Resuming past a limit is an explicit extension, for this task only.
      patch.limits = this.supervisor.extendedLimits(task);
      this.publisher.event(id, 'TASK_RESUMED', 'Limits extended by you for this task', { limits: patch.limits });
    }
    if (task.blocker?.kind === 'fix_limit' && task.blocker.stageKey) {
      // Resuming after the fix limit grants exactly one more cycle.
      const def = this.d.views.stageDef(task, task.blocker.stageKey);
      if (def?.onFail) {
        patch.maxFixCycles = task.fixCycles + 1;
        patch.fixCycles = task.fixCycles + 1;
        patch.currentStageKey = def.onFail;
        this.publisher.event(id, 'FIX_CYCLE', `Fix cycle ${task.fixCycles + 1} started (allowed by you)`);
      }
    }
    this.publisher.updateTask(id, patch);
    this.publisher.event(id, 'TASK_RESUMED', 'Task resumed');
    this.schedule();
  }

  async retry(id: string, stageKey?: string): Promise<void> {
    const task = this.task(id);
    if (!RESUMABLE.includes(task.status)) throw new EngineError(`A ${task.status.toLowerCase()} task cannot be retried`, 'INVALID_STATE');
    const key = stageKey ?? task.currentStageKey;
    if (!key || key === COMPLETE || !this.d.views.stageDef(task, key)) throw new EngineError(`Unknown stage "${key}"`, 'INVALID_INPUT');
    const cancelled = this.d.store.cancelPendingApprovals(id);
    for (const a of cancelled) this.d.bus.publish({ type: 'approval', approval: this.d.views.approval(a) });
    this.publisher.updateTask(id, { status: 'QUEUED', blocker: null, pauseRequested: false, currentStageKey: key, finalStatus: null });
    this.publisher.event(id, 'STAGE_RETRY', `Retry requested for ${this.d.views.stageDef(task, key)!.name}`);
    this.schedule();
  }

  async cancel(id: string): Promise<void> {
    const task = this.task(id);
    if (TERMINAL_TASK_STATUSES.includes(task.status)) throw new EngineError(`Task is already ${task.status.toLowerCase()}`, 'INVALID_STATE');
    if (this.runners.has(id)) await this.stop(id, 'cancel');
    const current = this.d.store.getTask(id)!;
    if (current.currentStageId) {
      const stage = this.d.store.getStage(current.currentStageId);
      if (stage && !['SUCCESS', 'SKIPPED', 'FAILED'].includes(stage.status)) this.publisher.updateStage(stage.id, { status: 'CANCELLED', finishedAt: now() });
    }
    for (const a of this.d.store.cancelPendingApprovals(id)) this.d.bus.publish({ type: 'approval', approval: this.d.views.approval(a) });
    const repo = this.d.store.getRepository(current.repositoryId);
    await this.d.tooling.cleanup(current, repo, 'task cancelled').catch(() => []);
    const multi = isMultiRepository(this.d.store, current);
    if (multi) await this.finalizeWorkspace(current, 'cancelled');
    const gitPatch = !multi && repo && current.git.worktreePath ? await this.d.tooling.finalizeWorktree(current, repo, 'cancelled') : {};
    this.publisher.updateTask(id, { status: 'CANCELLED', blocker: null, pauseRequested: false, pauseAfterStage: false, finishedAt: now(), ...(Object.keys(gitPatch).length ? { git: { ...this.task(id).git, ...gitPatch } } : {}) });
    this.publisher.event(id, 'TASK_CANCELLED', 'Task cancelled');
    this.supervisor?.onTerminal(id);
    this.schedule();
  }

  async reroute(
    id: string,
    input: { stageKey?: string; agentId: string; model?: string; effort?: string; reason?: string; applyToRole?: boolean; applyToAgent?: boolean },
  ): Promise<TaskDetail> {
    const task = this.task(id);
    if (TERMINAL_TASK_STATUSES.includes(task.status)) throw new EngineError(`Task is ${task.status.toLowerCase()}`, 'INVALID_STATE');
    const key = input.stageKey ?? task.currentStageKey;
    const def = this.d.views.stageDef(task, key);
    if (!def) throw new EngineError(`Unknown stage "${key}"`, 'INVALID_INPUT');
    if (def.kind !== 'agent') throw new EngineError(`${def.name} is run by the system and cannot be rerouted`, 'INVALID_INPUT');
    if (!this.d.agents.has(input.agentId)) throw new EngineError(`Unknown agent "${input.agentId}"`, 'INVALID_INPUT');

    const before = this.d.views.assignmentFor(task, def);
    const assignment: PartialAssignment = { agentId: input.agentId, model: input.model ?? 'default', effort: input.effort ?? before.effort };
    const overrides = structuredClone(task.overrides);
    overrides.stages[def.key] = assignment;
    if (input.applyToRole) overrides.roles[def.role] = assignment;
    const alsoMoved: string[] = [];
    if (input.applyToAgent && input.agentId !== before.agentId) {
      for (const other of task.workflow.stages) {
        if (other.kind !== 'agent' || other.key === def.key) continue;
        const current = this.d.views.assignmentFor(task, other);
        if (current.agentId !== before.agentId) continue;
        overrides.stages[other.key] = { agentId: input.agentId, model: input.model ?? 'default', effort: input.effort ?? current.effort };
        alsoMoved.push(other.name);
      }
    }
    this.publisher.updateTask(id, { overrides });
    const fromName = this.d.agents.has(before.agentId) ? this.d.agents.adapter(before.agentId).displayName : before.agentId;
    const toName = this.d.agents.adapter(input.agentId).displayName;
    this.publisher.event(
      id,
      'REROUTED',
      `${ROLE_LABEL[def.role]} rerouted · ${fromName} → ${toName}${alsoMoved.length ? ` · also ${alsoMoved.join(', ')}` : ''} · Reason: ${input.reason?.trim() || 'user action'}`,
      { stageKey: def.key, from: before, to: assignment, reason: input.reason ?? 'user action', alsoMoved },
    );

    const running = this.runners.get(id);
    if (running && task.currentStageKey === def.key && running.control.cancelCurrent) {
      await this.stop(id, 'reroute');
    } else if (!running && task.currentStageKey === def.key && RESUMABLE.includes(task.status) && task.blocker?.kind !== 'approval') {
      // Rerouting a stopped stage means "run it again with the new agent".
      this.publisher.updateTask(id, { status: 'QUEUED', blocker: null, pauseRequested: false });
      this.schedule();
    }
    return this.detail(id);
  }

  changeAssignment(id: string, input: { stageKey: string; agentId?: string; model?: string; effort?: string }): TaskDetail {
    const task = this.task(id);
    if (TERMINAL_TASK_STATUSES.includes(task.status)) throw new EngineError(`Task is ${task.status.toLowerCase()}`, 'INVALID_STATE');
    const def = this.d.views.stageDef(task, input.stageKey);
    if (!def) throw new EngineError(`Unknown stage "${input.stageKey}"`, 'INVALID_INPUT');
    if (def.kind !== 'agent') throw new EngineError(`${def.name} is run by the system`, 'INVALID_INPUT');
    if (this.runners.has(id) && task.currentStageKey === def.key) {
      throw new EngineError(`${def.name} is running now. Use Reroute to change its agent.`, 'INVALID_STATE');
    }
    if (input.agentId && !this.d.agents.has(input.agentId)) throw new EngineError(`Unknown agent "${input.agentId}"`, 'INVALID_INPUT');
    const overrides = structuredClone(task.overrides);
    const previous = overrides.stages[def.key] ?? {};
    const changedAgent = input.agentId !== undefined && input.agentId !== previous.agentId;
    overrides.stages[def.key] = {
      ...previous,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.model !== undefined ? { model: input.model } : changedAgent ? { model: 'default' } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    };
    this.publisher.updateTask(id, { overrides });
    const resolved = this.d.views.assignmentFor(this.task(id), def);
    this.publisher.event(id, 'ASSIGNMENT_CHANGED', `${def.name} will use ${this.d.agents.adapter(resolved.agentId).displayName} · ${resolved.model} · ${resolved.effort}`, {
      stageKey: def.key,
      assignment: resolved,
    });
    return this.detail(id);
  }

  async addDirective(
    id: string,
    input: { text: string; pause?: boolean; scope?: DirectiveScope; kind?: DirectiveKind; rule?: DirectiveRule | null; sourceMessageId?: string | null; supersedes?: string },
  ): Promise<Directive> {
    const task = this.task(id);
    if (TERMINAL_TASK_STATUSES.includes(task.status)) throw new EngineError(`Task is ${task.status.toLowerCase()}`, 'INVALID_STATE');
    const text = redact(input.text.trim());
    const directive: Directive = {
      id: newId(),
      taskId: id,
      text,
      // Routing directives take effect as assignments, not prompt text, so they are applied at once.
      status: input.kind === 'routing' ? 'applied' : 'queued',
      pauseRequested: Boolean(input.pause),
      createdAt: now(),
      appliedAt: input.kind === 'routing' ? now() : null,
      appliedStageKey: null,
      scope: input.scope ?? 'CURRENT_TASK',
      kind: input.kind ?? 'instruction',
      state: 'active',
      rule: input.rule ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      removedAt: null,
      supersededBy: null,
    };
    this.d.store.insertDirective(directive);
    this.d.bus.publish({ type: 'directive', directive });
    this.publisher.event(id, 'USER_DIRECTIVE', `Directive ${directive.status === 'queued' ? 'queued' : 'added'}: ${text.length > 120 ? `${text.slice(0, 119)}…` : text}`, { directiveId: directive.id, kind: directive.kind });
    if (input.supersedes) {
      const old = this.d.store.getDirective(input.supersedes);
      if (old && old.taskId === id && old.state === 'active') this.d.bus.publish({ type: 'directive', directive: this.d.store.retireDirective(old.id, 'superseded', directive.id) });
    }
    if (input.pause && task.status === 'RUNNING') await this.pause(id);
    // Answering the question a stage stopped on is what the operator was asked to do: continue with the answer.
    if (task.status === 'WAITING_FOR_USER' && task.blocker?.kind === 'decision' && directive.kind !== 'routing' && !input.pause) {
      this.publisher.event(id, 'TASK_RESUMED', 'Your answer was recorded; the stage runs again with it');
      await this.resume(id);
    }
    return directive;
  }

  removeDirective(id: string, directiveId: string): Directive {
    this.task(id);
    const directive = this.d.store.getDirective(directiveId);
    if (!directive || directive.taskId !== id) throw new EngineError('Directive not found', 'NOT_FOUND');
    if (directive.state !== 'active') throw new EngineError(`That directive was already ${directive.state}`, 'INVALID_STATE');
    const removed = this.d.store.retireDirective(directiveId, 'removed');
    this.d.bus.publish({ type: 'directive', directive: removed });
    this.publisher.event(id, 'DIRECTIVE_REMOVED', `Directive removed: ${removed.text.length > 120 ? `${removed.text.slice(0, 119)}…` : removed.text}`, { directiveId });
    return removed;
  }

  /**
   * Stop the running loop (if any) and apply `plan` once it has let go. Only
   * one worker can ever mutate a task: the new state is written after the
   * old loop has fully exited, and the scheduler starts a fresh one.
   */
  private async stopAndApply(id: string, plan: Omit<RedirectPlan, 'applied'>): Promise<void> {
    const full: RedirectPlan = { ...plan, applied: false };
    const runner = this.runners.get(id);
    if (runner) {
      runner.control.redirect = full;
      runner.control.stopReason = 'redirect';
      await runner.control.cancelCurrent?.();
      await runner.done;
      if (full.applied) return;
    }
    const task = this.task(id);
    if (TERMINAL_TASK_STATUSES.includes(task.status)) throw new EngineError(`Task is already ${task.status.toLowerCase()}`, 'INVALID_STATE');
    this.applyPlan(task, full, null);
  }

  private applyPlan(task: TaskRecord, plan: RedirectPlan, stage: StageInstance | null): void {
    const current = stage ?? (task.currentStageId ? this.d.store.getStage(task.currentStageId) : null);
    if (current && ['STARTING', 'RUNNING', 'RETRYING', 'WAITING_APPROVAL', 'PAUSED'].includes(current.status)) {
      this.publisher.updateStage(current.id, { status: plan.stageStatus, summary: plan.summary, finishedAt: now() });
    }
    if (plan.withdrawApprovals) for (const a of this.d.store.cancelPendingApprovals(task.id)) this.d.bus.publish({ type: 'approval', approval: this.d.views.approval(a) });
    this.publisher.updateTask(task.id, plan.patch);
    this.publisher.event(task.id, plan.event.type, plan.event.message, plan.event.data ?? {});
    plan.applied = true;
  }

  /** Send the task to `stageKey` (or `complete`), stopping whatever runs now. */
  async redirect(id: string, stageKey: string, opts: { reason: string; patch?: Partial<TaskRecord> }): Promise<void> {
    const task = this.task(id);
    if (TERMINAL_TASK_STATUSES.includes(task.status)) throw new EngineError(`Task is ${task.status.toLowerCase()}`, 'INVALID_STATE');
    if (task.status === 'DRAFT') throw new EngineError('Start the task first', 'INVALID_STATE');
    const def = stageKey === COMPLETE ? null : this.d.views.stageDef(task, stageKey);
    if (stageKey !== COMPLETE && !def) throw new EngineError(`Unknown stage "${stageKey}"`, 'INVALID_INPUT');
    const target = def?.name ?? 'completion';
    await this.stopAndApply(id, {
      patch: { status: 'QUEUED', currentStageKey: stageKey, blocker: null, pauseRequested: false, pauseAfterStage: false, finalStatus: null, ...opts.patch },
      stageStatus: 'CANCELLED',
      summary: `Stopped: ${opts.reason}`,
      event: { type: 'TASK_REDIRECTED', message: `Redirected to ${target} · ${opts.reason}`, data: { stageKey } },
      withdrawApprovals: true,
    });
    this.schedule();
  }

  /**
   * The same transition from inside the loop (a Chairman recovery decision at
   * a stage boundary): nothing is running, so the loop just continues there.
   */
  redirectInLoop(id: string, stageKey: string, opts: { reason: string; patch?: Partial<TaskRecord> }): void {
    const task = this.task(id);
    const def = stageKey === COMPLETE ? null : this.d.views.stageDef(task, stageKey);
    if (stageKey !== COMPLETE && !def) throw new EngineError(`Unknown stage "${stageKey}"`, 'INVALID_INPUT');
    this.publisher.updateTask(id, { currentStageKey: stageKey, ...opts.patch });
    this.publisher.event(id, 'TASK_REDIRECTED', `Redirected to ${def?.name ?? 'completion'} · ${opts.reason}`, { stageKey });
  }

  /** Apply a task patch from inside the loop (recovery bookkeeping). */
  applyInLoop(id: string, patch: Partial<TaskRecord>): TaskRecord {
    return this.publisher.updateTask(id, patch);
  }

  /** Stop the running worker and leave the task paused for instructions. */
  async stopActiveStage(id: string, reason: string): Promise<void> {
    if (!this.runners.has(id)) throw new EngineError('No stage is running', 'INVALID_STATE');
    await this.stopAndApply(id, {
      patch: { status: 'PAUSED', pauseRequested: false, pauseAfterStage: false },
      stageStatus: 'CANCELLED',
      summary: `Stopped: ${reason}`,
      event: { type: 'TASK_PAUSED', message: `Stopped the active stage · ${reason}` },
      withdrawApprovals: false,
    });
  }

  /** Pause at the next stage boundary; the running stage finishes first. */
  pauseAfterStage(id: string): void {
    const task = this.task(id);
    if (task.status === 'QUEUED') {
      this.publisher.updateTask(id, { status: 'PAUSED', blocker: null });
      this.publisher.event(id, 'TASK_PAUSED', 'Task paused before it started');
      return;
    }
    if (task.status !== 'RUNNING') throw new EngineError(`A ${task.status.toLowerCase()} task cannot be paused`, 'INVALID_STATE');
    this.publisher.updateTask(id, { pauseAfterStage: true });
    const def = this.d.views.stageDef(task, task.currentStageKey);
    this.publisher.event(id, 'TASK_PAUSED', `Will pause after ${def?.name ?? 'the current stage'}`);
  }

  clearPauseAfterStage(id: string): void {
    if (this.task(id).pauseAfterStage) this.publisher.updateTask(id, { pauseAfterStage: false });
  }

  /** Park the task on a blocker only a person can clear (or a limit). */
  async block(id: string, kind: 'hard_blocker' | 'limit', message: string, opts: { inLoop?: boolean; stageKey?: string } = {}): Promise<void> {
    const task = this.task(id);
    const blocker = { kind, message, stageKey: opts.stageKey ?? task.currentStageKey ?? undefined };
    const eventMessage = kind === 'limit' ? `Paused at a limit: ${message}` : `Hard blocker: ${message}`;
    if (opts.inLoop || !this.runners.has(id)) {
      if (TERMINAL_TASK_STATUSES.includes(task.status)) throw new EngineError(`Task is ${task.status.toLowerCase()}`, 'INVALID_STATE');
      this.publisher.updateTask(id, { status: 'WAITING_FOR_USER', blocker, pauseRequested: false, pauseAfterStage: false });
      this.publisher.event(id, 'TASK_WAITING', eventMessage);
      return;
    }
    await this.stopAndApply(id, {
      patch: { status: 'WAITING_FOR_USER', blocker, pauseRequested: false, pauseAfterStage: false },
      stageStatus: 'CANCELLED',
      summary: eventMessage,
      event: { type: 'TASK_WAITING', message: eventMessage },
      withdrawApprovals: true,
    });
  }

  /**
   * Change a stage's agent/model/effort for its next run without interrupting
   * the current one (a deferred routing directive).
   */
  setAssignment(id: string, input: { stageKey: string; agentId?: string; model?: string; effort?: string; applyToRole?: boolean }, reason: string): TaskDetail {
    const task = this.task(id);
    if (TERMINAL_TASK_STATUSES.includes(task.status)) throw new EngineError(`Task is ${task.status.toLowerCase()}`, 'INVALID_STATE');
    const def = this.d.views.stageDef(task, input.stageKey);
    if (!def) throw new EngineError(`Unknown stage "${input.stageKey}"`, 'INVALID_INPUT');
    if (def.kind !== 'agent') throw new EngineError(`${def.name} is run by the system and has no agent`, 'INVALID_INPUT');
    if (input.agentId && !this.d.agents.has(input.agentId)) throw new EngineError(`Unknown agent "${input.agentId}"`, 'INVALID_INPUT');
    const overrides = structuredClone(task.overrides);
    const previous = overrides.stages[def.key] ?? {};
    const changedAgent = input.agentId !== undefined && input.agentId !== previous.agentId;
    const next = {
      ...previous,
      ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      ...(input.model !== undefined ? { model: input.model } : changedAgent ? { model: 'default' } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    };
    overrides.stages[def.key] = next;
    if (input.applyToRole) overrides.roles[def.role] = next;
    this.publisher.updateTask(id, { overrides });
    const resolved = this.d.views.assignmentFor(this.task(id), def);
    const running = this.runners.has(id) && task.currentStageKey === def.key;
    this.publisher.event(
      id,
      'ASSIGNMENT_CHANGED',
      `${def.name} will use ${this.d.agents.adapter(resolved.agentId).displayName} · ${resolved.model} · ${resolved.effort}${running ? ' from its next run' : ''} · ${reason}`,
      { stageKey: def.key, assignment: resolved },
    );
    return this.detail(id);
  }

  /** Ask the next tests stage to also run these command kinds (one-shot). */
  requestChecks(id: string, kinds: CommandKind[]): void {
    const task = this.task(id);
    const next = [...new Set([...task.extraCheckKinds, ...kinds])];
    this.publisher.updateTask(id, { extraCheckKinds: next });
  }

  /** Loops currently holding a task, for the watchdog. */
  activeRuns(): Array<{ taskId: string; control: RunControl }> {
    return [...this.runners.entries()].map(([taskId, r]) => ({ taskId, control: r.control }));
  }

  /** Stop a stuck or dead worker; the stage fails with the reason and recovery takes over. */
  async watchdogStop(id: string, reason: string): Promise<boolean> {
    const runner = this.runners.get(id);
    if (!runner || runner.control.stopReason || !runner.control.cancelCurrent) return false;
    runner.control.stopReason = 'watchdog';
    runner.control.watchdogReason = reason;
    await runner.control.cancelCurrent();
    return true;
  }

  /** A task the database says is RUNNING with no loop behind it (a ghost). */
  reconcileGhost(id: string, reason: string): boolean {
    const task = this.task(id);
    if (task.status !== 'RUNNING' || this.runners.has(id)) return false;
    const stage = task.currentStageId ? this.d.store.getStage(task.currentStageId) : null;
    if (stage && ['STARTING', 'RUNNING', 'RETRYING'].includes(stage.status)) this.publisher.updateStage(stage.id, { status: 'INTERRUPTED', finishedAt: now() });
    for (const exec of this.d.store.listExecutions(id).filter((e) => e.status === 'running')) {
      this.d.store.updateExecution(exec.id, { status: 'interrupted', finishedAt: now(), errorMessage: reason });
    }
    this.publisher.updateTask(id, {
      status: 'INTERRUPTED',
      pauseRequested: false,
      blocker: { kind: 'interrupted', message: `${reason}. Resume to run ${stage?.name ?? 'it'} again.`, stageKey: stage?.stageKey },
    });
    this.publisher.event(id, 'WATCHDOG', `${reason}; marked interrupted`);
    return true;
  }

  async resolveApproval(approvalId: string, decision: 'approve' | 'deny', input: { note?: string; confirmation?: string } = {}): Promise<void> {
    const approval = this.d.store.getApproval(approvalId);
    if (!approval) throw new EngineError('Approval not found', 'NOT_FOUND');
    if (approval.status !== 'pending') throw new EngineError(`This approval was already ${approval.status}`, 'INVALID_STATE');
    if (decision === 'approve' && approval.confirmationPhrase && input.confirmation?.trim() !== approval.confirmationPhrase) {
      throw new EngineError(`Type ${approval.confirmationPhrase} to confirm this approval`, 'CONFIRMATION_REQUIRED');
    }
    const note = input.note?.trim() ? redact(input.note.trim()) : null;
    const resolved = this.d.store.resolveApproval(approvalId, decision === 'approve' ? 'approved' : 'denied', note);
    this.d.bus.publish({ type: 'approval', approval: this.d.views.approval(resolved) });
    this.publisher.event(
      approval.taskId,
      'APPROVAL_RESOLVED',
      `${decision === 'approve' ? 'Approved' : 'Denied'}: ${approval.action}${note ? ` · ${note}` : ''}`,
      { approvalId, decision },
      approval.stageId,
    );

    // The Release button's approval belongs to a completed task, not to the loop (RELEASE_STAGE_PLAN §3.6).
    if (approval.kind === 'release') {
      this.release.onButtonDecision(resolved, decision);
      return;
    }

    const task = this.task(approval.taskId);
    if (task.status !== 'WAITING_FOR_USER' || task.blocker?.approvalId !== approvalId) return;

    if (decision === 'approve') {
      this.publisher.updateTask(task.id, { status: 'QUEUED', blocker: null });
      this.schedule();
      return;
    }
    if (approval.kind === 'plan_review') {
      // Denying a plan sends it back to the planner with the feedback as a directive.
      if (note) await this.addDirective(task.id, { text: `Plan feedback: ${note}` });
      this.publisher.updateTask(task.id, { status: 'QUEUED', blocker: null, currentStageKey: approval.stageKey });
      this.publisher.event(task.id, 'STAGE_RETRY', 'Plan sent back for revision');
      this.schedule();
      return;
    }
    const declined = approval.kind === 'stage_permission' && approval.stageKey ? this.d.views.stageDef(task, approval.stageKey) : null;
    if (declined?.kind === 'release') {
      // Declining a release is a decision, not a failure: nothing is sent, the task completes, and the Release button stays (§3.5).
      const stage = this.createStageInstance(task, declined);
      this.publisher.updateStage(stage.id, { status: 'SKIPPED', summary: 'Release declined', finishedAt: now() });
      this.publisher.event(task.id, 'RELEASE_DECLINED', 'Release declined; nothing was sent. You can release later with the Release button.', { approvalId }, stage.id);
      this.publisher.event(task.id, 'STAGE_SKIPPED', `${declined.name} skipped: release declined`, {}, stage.id);
      this.publisher.updateTask(task.id, { status: 'QUEUED', blocker: null, currentStageKey: declined.next });
      this.schedule();
      return;
    }
    this.publisher.updateTask(task.id, {
      status: 'FAILED',
      blocker: { kind: 'error', message: `You denied: ${approval.action}. Retry the stage to be asked again, or cancel the task.`, stageKey: approval.stageKey ?? undefined },
    });
    this.publisher.event(task.id, 'TASK_FAILED', `Stopped: approval denied for ${approval.action}`);
  }

  // ===========================================================================
  // Scheduling
  // ===========================================================================

  /** Start queued tasks whose repository is free. Safe to call at any time. */
  schedule(): void {
    if (this.shuttingDown || this.draining) return;
    if (this.scheduling) {
      this.rescheduleRequested = true;
      return;
    }
    this.scheduling = true;
    try {
      do {
        this.rescheduleRequested = false;
        const queued = this.d.store.listTasks({ statuses: ['QUEUED'], limit: 500 }).sort((a, b) => a.seq - b.seq);
        for (const task of queued) {
          if (this.runners.has(task.id)) continue;
          const held = isReadOnlyWorkflow(task.workflow) ? null : this.repositoryHolder(task);
          if (held) {
            const { holder, repositoryId } = held;
            // Name the shared repository when either task works in more than one.
            const where = isMultiRepository(this.d.store, task) || isMultiRepository(this.d.store, holder) ? ` (${this.d.store.getRepository(repositoryId)?.name ?? repositoryId})` : '';
            const message = `Waiting for ${holder.id} (${holder.status.toLowerCase().replace(/_/g, ' ')}) in the same repository${where}`;
            if (task.blocker?.message !== message) this.publisher.updateTask(task.id, { blocker: { kind: 'queued', message } });
            continue;
          }
          this.launch(task);
        }
      } while (this.rescheduleRequested);
    } finally {
      this.scheduling = false;
    }
  }

  /**
   * The task holding a repository: one that is running, or one that has
   * already started changing files (it has a baseline) and is not finished.
   * Read-only workflows never hold a repository. A task across repositories
   * waits for any task sharing one of them, and holds all of them.
   */
  private repositoryHolder(task: TaskRecord): { holder: TaskRecord; repositoryId: string } | null {
    const candidates: Array<{ holder: TaskRecord; repositoryId: string }> = [];
    for (const repositoryId of taskRepositoryIds(this.d.store, task)) {
      for (const t of this.d.store.listTasks({ repositoryId, limit: 1000 })) {
        if (t.id === task.id || ['DRAFT', 'QUEUED', ...TERMINAL_TASK_STATUSES].includes(t.status) || isReadOnlyWorkflow(t.workflow)) continue;
        candidates.push({ holder: t, repositoryId });
      }
    }
    return candidates.find((c) => c.holder.status === 'RUNNING' || this.runners.has(c.holder.id)) ?? candidates.find((c) => c.holder.git.baselineSnapshotId) ?? null;
  }

  /** Refresh the cached Git status of every repository a task works in. */
  private invalidateRepositories(task: TaskRecord): void {
    for (const id of taskRepositoryIds(this.d.store, task)) this.d.repositories.invalidate(id);
  }

  private launch(task: TaskRecord): void {
    const control: RunControl = { stopReason: null, cancelCurrent: null, autoRetries: new Map(), redirect: null, watchdogReason: null };
    const firstStart = !task.startedAt;
    this.publisher.updateTask(task.id, { status: 'RUNNING', blocker: null, startedAt: task.startedAt ?? now() });
    if (firstStart) this.publisher.event(task.id, 'TASK_STARTED', 'Task started');
    const done = this.runLoop(task.id, control)
      .catch((error: unknown) => {
        const message = redact((error as Error)?.message ?? String(error));
        this.publisher.updateTask(task.id, { status: 'FAILED', blocker: { kind: 'error', message: `Internal error: ${message}`, errorClass: 'UNKNOWN' } });
        this.publisher.event(task.id, 'TASK_FAILED', `Internal error: ${message}`);
      })
      .finally(() => {
        this.runners.delete(task.id);
        this.invalidateRepositories(task);
        // Background processes live only while the loop does; a paused or waiting task restarts them if it needs them.
        const after = this.d.store.getTask(task.id);
        if (after && !['RUNNING', 'QUEUED'].includes(after.status)) void this.d.tooling.stopProcesses(task.id, `task ${after.status.toLowerCase().replace(/_/g, ' ')}`);
        setImmediate(() => this.schedule());
        this.checkDrained();
      });
    this.runners.set(task.id, { control, done });
  }

  /**
   * Ask a running loop to stop its current execution. For pause, cancel and
   * shutdown this waits until the loop has exited; a reroute only interrupts
   * the stage, and the same loop carries on with the new agent.
   */
  private async stop(id: string, reason: StopReason): Promise<void> {
    const runner = this.runners.get(id);
    if (!runner) return;
    runner.control.stopReason = reason;
    await runner.control.cancelCurrent?.();
    if (reason !== 'reroute') await runner.done;
  }

  // ===========================================================================
  // The loop
  // ===========================================================================

  private async runLoop(taskId: string, control: RunControl): Promise<void> {
    let environmentChecked = false;
    for (;;) {
      const task = this.task(taskId);
      if (task.status !== 'RUNNING') return;
      if (control.stopReason === 'cancel' || control.stopReason === 'shutdown' || control.stopReason === 'redirect') return this.stopped(task, control.stopReason, null);
      if (task.pauseRequested || task.pauseAfterStage || control.stopReason === 'pause') return this.stopped(task, 'pause', null);
      // Draining for a restart: stop here, between stages, so nothing is cut off mid-stage (§3.G).
      if (this.draining) return this.stopped(task, 'shutdown', null);

      const key = task.currentStageKey ?? task.workflow.stages[0]!.key;
      if (key === COMPLETE) {
        if (!this.supervises(task)) return this.complete(task);
        const gate = await this.supervisor!.beforeComplete(taskId, control);
        if (gate.kind === 'continue') continue;
        if (gate.kind === 'stop') return this.afterHook(taskId, control);
        return this.complete(this.task(taskId), gate.limitations);
      }
      const def = this.d.views.stageDef(task, key);
      if (!def) throw new Error(`Workflow snapshot has no stage "${key}"`);

      const repo = this.d.repositories.record(task.repositoryId);
      // A stage whose prerequisite did not succeed has nothing to act on: skipped before any approval is asked.
      const unmet = this.unmetRequirement(task, def);
      if (unmet) {
        const skipped = this.createStageInstance(task, def);
        this.publisher.updateStage(skipped.id, { status: 'SKIPPED', summary: `Skipped: ${unmet}`, finishedAt: now() });
        this.publisher.event(taskId, 'STAGE_SKIPPED', `${def.name} skipped: ${unmet}`, { requires: def.requires }, skipped.id);
        if (!(await this.handleOutcome(taskId, def, skipped, { kind: 'skipped', stageId: skipped.id }, control))) return;
        continue;
      }
      // A release with nothing to do (none set up, nothing committed) is skipped before any approval is asked (RELEASE_STAGE_PLAN §3.5).
      const releaseSkip = def.kind === 'release' ? this.release.skipReason(task, repo) : null;
      if (releaseSkip) {
        const skipped = this.createStageInstance(task, def);
        this.publisher.updateStage(skipped.id, { status: 'SKIPPED', summary: releaseSkip, finishedAt: now() });
        this.publisher.event(taskId, 'STAGE_SKIPPED', `${def.name} skipped: ${releaseSkip}`, {}, skipped.id);
        if (!(await this.handleOutcome(taskId, def, skipped, { kind: 'skipped', stageId: skipped.id }, control))) return;
        continue;
      }
      if (!skipsForLackOfCommands(def, taskRepositories(this.d.store, task).map((r) => r.repo)) && !this.stageGate(task, def)) return;

      // A stage that can edit files waits for any Source Control mutation in
      // flight, and Source Control refuses to mutate while it runs — unless the
      // task is isolated in its own worktree and never touches that working tree.
      // A release edits no files: it takes the writer lock itself, only while it checks and pushes.
      const writes = def.permissionLevel >= 2 && def.kind !== 'release';
      const releaseWriter = writes && !task.git.isolated ? await this.d.coordinator.acquireWriter(repo.id, taskId, def.name) : null;
      let stage: StageInstance;
      let outcome: StageOutcome;
      try {
        if ((writes || task.git.isolated) && !(await this.ensureBaseline(this.task(taskId), repo.path))) return;
        if (!environmentChecked) {
          environmentChecked = true;
          await this.d.tooling.discoverEnvironment(this.task(taskId), repo).catch((error: unknown) => {
            this.publisher.event(taskId, 'ENVIRONMENT_DISCOVERED', `Environment discovery failed: ${redact((error as Error).message).slice(0, 200)}`);
          });
        }
        // A drain requested while the baseline was prepared (a worktree's install takes minutes) stops here,
        // before the stage starts, not after it (found in the TASK-0008 replay).
        if (this.draining) return this.stopped(this.task(taskId), 'shutdown', null);
        // The Chairman checks limits and takes its before-stage checkpoint while this writer lock is held;
        // its rollbacks, which run outside a stage, take the lock themselves (CheckpointService.restore).
        if (this.supervises(task) && !(await this.supervisor!.beforeStage(this.task(taskId), def, control))) return this.afterHook(taskId, control);
        stage = this.createStageInstance(this.task(taskId), def);
        switch (def.kind) {
          case 'agent':
            outcome = await this.stages.runAgent(this.task(taskId), def, stage, repo, control);
            break;
          case 'tests':
          case 'command':
            outcome = await this.stages.runCommands(this.task(taskId), def, stage, repo, control);
            break;
          case 'git':
            outcome = await this.stages.runGit(this.task(taskId), def, stage, repo);
            break;
          case 'verify':
            outcome = await this.stages.runVerify(this.task(taskId), def, stage, repo, control);
            break;
          case 'release':
            outcome = await this.stages.runRelease(this.task(taskId), def, stage, repo, control);
            break;
        }
      } finally {
        releaseWriter?.();
        this.invalidateRepositories(task);
      }
      if (!(await this.handleOutcome(taskId, def, stage, outcome, control))) return;
    }
  }

  /**
   * The first of a stage's `requires` whose latest run did not end SUCCESS,
   * worded for the timeline ("Staging deploy did not run"), or null.
   */
  private unmetRequirement(task: TaskRecord, def: StageDefinition): string | null {
    if (!def.requires?.length) return null;
    const stages = this.d.store.listStages(task.id);
    for (const key of def.requires) {
      const last = stages.filter((s) => s.stageKey === key).at(-1);
      if (last?.status === 'SUCCESS') continue;
      const name = this.d.views.stageDef(task, key)?.name ?? key;
      return last && last.status !== 'SKIPPED' ? `${name} did not succeed` : `${name} did not run`;
    }
    return null;
  }

  /** A hook returned "stop": honour a pending stop request, else the hook parked the task itself. */
  private afterHook(taskId: string, control: RunControl): void {
    const task = this.task(taskId);
    if (control.stopReason && task.status === 'RUNNING') this.stopped(task, control.stopReason, null);
  }

  /** Permission gate before a stage starts. Returns false when the task must wait. */
  private approvalSpent(task: TaskRecord, def: StageDefinition): boolean {
    if (!def.requiresApproval && def.permissionLevel < 5) return false;
    const approval = this.d.store.findApproval(task.id, 'stage_permission', { stageKey: def.key });
    if (!approval?.resolvedAt) return false;
    return this.d.store.listStages(task.id).some((s) => s.stageKey === def.key && s.createdAt >= approval.resolvedAt! && s.status !== 'WAITING_APPROVAL');
  }

  private stageGate(task: TaskRecord, def: StageDefinition): boolean {
    const autoLevel = this.d.tooling.autoApproveLevel(task, this.d.repositories.record(task.repositoryId));
    if (!def.requiresApproval && def.permissionLevel <= autoLevel) return true;
    const state = this.approvals.state(task.id, 'stage_permission', { stageKey: def.key });
    // A stage the workflow always asks about (or a Level 5 one) is approved for one attempt:
    // once an instance of it has started since the approval, a retry or a fix cycle asks again (audit F-09).
    if (state === 'approved' && !this.approvalSpent(task, def)) return true;
    const pending = this.approvals.pending(task.id, 'stage_permission', { stageKey: def.key });
    if (pending) {
      this.approvals.park(task, pending);
      return false;
    }
    const assignment = def.kind === 'agent' ? this.d.views.assignmentFor(task, def) : null;
    const level = PERMISSION_LEVEL_INFO[def.permissionLevel];
    if (def.kind === 'release') {
      // The card says what is sent, where, and how Live is proved (§3.5).
      const card = this.release.describe(task, this.d.repositories.record(task.repositoryId));
      const approval = this.approvals.request(task, { kind: 'stage_permission', stageId: null, stageKey: def.key, requestedBy: 'system', action: card.action, permissionLevel: 5, risk: 'dangerous', reason: card.reason, riskExplanation: card.riskExplanation, environment: card.environment });
      this.publisher.event(task.id, 'RELEASE_REQUESTED', `Release requested: ${card.action} — waiting for your typed approval`, { approvalId: approval.id, commit: task.git.commits.at(-1), via: 'stage' });
      return false;
    }
    this.approvals.request(task, {
      kind: 'stage_permission',
      stageId: null,
      stageKey: def.key,
      requestedBy: assignment ? this.d.agents.adapter(assignment.agentId).displayName : 'system',
      action: `Start ${def.name}`,
      permissionLevel: def.permissionLevel,
      risk: def.permissionLevel >= 5 ? 'dangerous' : def.permissionLevel >= 3 ? 'elevated' : 'normal',
      reason: def.requiresApproval
        ? `The ${task.workflow.name} workflow requires approval before ${def.name}.`
        : `${def.name} needs Level ${def.permissionLevel} (${level.name}); this task auto-approves up to Level ${autoLevel}.`,
      riskExplanation: level.description,
      environment: def.permissionLevel >= 4 ? (def.permissionLevel === 5 ? 'production' : 'staging') : null,
    });
    return false;
  }

  private createStageInstance(task: TaskRecord, def: StageDefinition): StageInstance {
    const assignment = def.kind === 'agent' ? this.d.views.assignmentFor(task, def) : null;
    const previous = this.d.store.listStages(task.id).filter((s) => s.stageKey === def.key);
    const parked = previous.at(-1);
    if (parked?.status === 'WAITING_APPROVAL') {
      // The stage was waiting on an approval that has now been granted: continue the same attempt.
      const resumed = this.publisher.updateStage(parked.id, { status: 'STARTING', summary: null, startedAt: now() });
      this.publisher.updateTask(task.id, { currentStageId: resumed.id, currentStageKey: def.key });
      return resumed;
    }
    const stage: StageInstance = {
      id: newId(),
      taskId: task.id,
      stageKey: def.key,
      name: def.name,
      role: def.role,
      kind: def.kind,
      status: 'STARTING',
      agentId: assignment?.agentId ?? null,
      model: assignment?.model ?? null,
      effort: assignment?.effort ?? null,
      permissionLevel: def.permissionLevel,
      attempt: previous.length + 1,
      cycle: task.fixCycles,
      verdict: null,
      summary: null,
      errorClass: null,
      errorMessage: null,
      startedAt: now(),
      finishedAt: null,
      createdAt: now(),
    };
    this.d.store.insertStage(stage);
    this.publisher.stage(stage);
    this.publisher.updateTask(task.id, { currentStageId: stage.id, currentStageKey: def.key });
    const who = assignment ? ` · ${this.d.agents.has(assignment.agentId) ? this.d.agents.adapter(assignment.agentId).displayName : assignment.agentId}` : '';
    this.publisher.event(task.id, 'STAGE_STARTED', `${def.name} started${who}`, { stageKey: def.key, attempt: stage.attempt, cycle: stage.cycle }, stage.id);
    return stage;
  }

  /**
   * Record the Git baseline and create the task branch before the first
   * write-capable stage. Returns false when the task was parked instead.
   */
  private async ensureBaseline(task: TaskRecord, repoPath: string): Promise<boolean> {
    if (isMultiRepository(this.d.store, task)) return this.ensureWorkspace(task);
    if (task.git.baselineSnapshotId) return true;
    if (!(await isGitRepository(repoPath))) {
      if (!this.d.store.lastEventOfType(task.id, ['GIT_BASELINE'])) {
        this.publisher.event(task.id, 'GIT_BASELINE', 'Not a Git repository: changes cannot be tracked or separated from existing work');
      }
      return true;
    }
    const repo = this.d.repositories.record(task.repositoryId);
    if (task.git.isolated) {
      // Worktree mode: the task gets its own checkout of HEAD on its own branch.
      // Nothing in your working tree — including uncommitted work — is involved.
      const created = await this.d.tooling.createWorktree(task, repo);
      if (created.ok) {
        const snapshotId = newId();
        this.d.store.insertSnapshot({ id: snapshotId, taskId: task.id, stageId: null, kind: 'baseline', branch: created.taskBranch, head: created.head, files: [], createdAt: now() });
        this.publisher.updateTask(task.id, {
          git: { ...task.git, baselineSnapshotId: snapshotId, baselineCommit: created.head, baselineBranch: await currentBranch(repoPath), taskBranch: created.taskBranch, preexistingChanges: [], worktreePath: created.worktreePath, isolated: true },
        });
        this.publisher.event(task.id, 'GIT_BASELINE', `Baseline recorded at ${created.head.slice(0, 10)} in an isolated worktree · your working tree is not touched`, { head: created.head, branch: created.taskBranch, worktree: created.worktreePath });
        await this.d.tooling.prepareWorktree(this.task(task.id), repo);
        return true;
      }
      // Never fall back to the operator's own checkout (§3.F): stop before anything is touched; Resume tries again.
      const message = `Couldn't create an isolated worktree: ${created.reason}. Your working folder was not touched. Fix the cause, then resume to try again.`;
      this.publisher.updateTask(task.id, { status: 'WAITING_FOR_USER', blocker: { kind: 'hard_blocker', message, stageKey: task.currentStageKey ?? undefined } });
      this.publisher.event(task.id, 'TASK_WAITING', `Hard blocker: ${message}`);
      return false;
    }
    const snap: GitSnapshot = await snapshot(repoPath);
    const snapshotId = newId();
    this.d.store.insertSnapshot({ id: snapshotId, taskId: task.id, stageId: null, kind: 'baseline', branch: snap.branch, head: snap.head, files: snap.files, createdAt: now() });
    let taskBranch: string | null = null;
    if (repo.gitMode === 'task-branch') {
      taskBranch = await createTaskBranch(repoPath, taskBranchName(task.id, task.title));
    }
    const preexisting = snap.files.map((f) => f.path);
    this.publisher.updateTask(task.id, {
      git: { ...task.git, baselineSnapshotId: snapshotId, baselineCommit: snap.head, baselineBranch: snap.branch, taskBranch, preexistingChanges: preexisting },
    });
    this.publisher.event(
      task.id,
      'GIT_BASELINE',
      `Baseline recorded on ${snap.branch ?? 'detached HEAD'} at ${snap.head?.slice(0, 10) ?? 'an empty repository'}${preexisting.length ? ` · ${preexisting.length} pre-existing change${preexisting.length === 1 ? '' : 's'} protected` : ' · working tree clean'}`,
      { head: snap.head, branch: snap.branch, preexisting },
    );
    if (taskBranch) this.publisher.event(task.id, 'GIT_BRANCH', `Working on branch ${taskBranch}`, { branch: taskBranch });
    const owner = taskIdFromBranch(snap.branch);
    const stackedOn = owner !== task.id ? owner : null;
    if (stackedOn) {
      this.publisher.event(
        task.id,
        'GIT_BRANCH',
        `Started from ${stackedOn}'s branch ${snap.branch}, not your main line: this task's work includes ${stackedOn}'s unmerged changes. Merge ${stackedOn} first, or merge both in order.`,
        { branch: snap.branch, stackedOn },
      );
    }
    return true;
  }

  /** Every repository of a task across repositories must be Git with a first commit, or the task is refused before anything is written. */
  private async checkWorkspaceRepositories(repos: Array<{ name: string; path: string }>): Promise<void> {
    for (const r of repos) {
      if (!(await isGitRepository(r.path))) throw new EngineError(`${r.name} is not a Git repository. A task across several repositories needs Git in each of them.`, 'INVALID_INPUT');
      if (!(await headCommit(r.path))) throw new EngineError(`${r.name} has no commits yet. Commit once before using it in a task across several repositories.`, 'INVALID_INPUT');
    }
  }

  /**
   * A task across repositories: one worktree per repository, side by side in
   * the task workspace, all created before the first stage runs
   * (docs/plans/MULTI_REPO_TASKS_PLAN.md). A repository already baselined
   * is kept, so this resumes after an interruption. When one cannot be
   * prepared, the worktrees and untouched branches this attempt made are
   * removed again and the task waits for you. Returns false when parked.
   */
  private async ensureWorkspace(task: TaskRecord): Promise<boolean> {
    const repos = taskRepositories(this.d.store, task);
    if (repos.every((r) => r.git.baselineSnapshotId) && task.git.workspacePath) {
      // Resuming: the records say ready; the worktrees must still be there, or work would land outside every branch.
      const missing = repos.find((r) => !r.git.worktreePath || !existsSync(path.join(r.git.worktreePath, '.git')));
      if (!missing) return true;
      const message = `The worktree of ${missing.repo.name} is missing (${missing.git.worktreePath ?? 'never recorded'}); it was removed outside the Control Center. Its task branch ${missing.git.taskBranch ?? ''} still holds committed work. Cancel this task and start a new one.`;
      this.publisher.updateTask(task.id, { status: 'WAITING_FOR_USER', blocker: { kind: 'error', message, errorClass: 'UNKNOWN' } });
      this.publisher.event(task.id, 'TASK_WAITING', message);
      return false;
    }
    const workspace = this.d.tooling.workspaceRoot(task);
    const created: Array<{ entry: TaskRepository; dir: string; taskBranch: string; head: string }> = [];
    let current: TaskRepository | null = null;
    try {
      for (const entry of repos) {
        if (entry.git.baselineSnapshotId) continue;
        current = entry;
        const dir = path.join(workspace, entry.folder!);
        const made = await this.d.tooling.addWorkspaceWorktree(this.task(task.id), entry.repo, dir);
        created.push({ entry, dir, ...made });
        const snapshotId = newId();
        this.d.store.insertSnapshot({ id: snapshotId, taskId: task.id, stageId: null, kind: 'baseline', branch: made.taskBranch, head: made.head, files: [], createdAt: now() });
        this.publisher.updateRepositoryGit(task.id, entry.repo.id, {
          baselineSnapshotId: snapshotId,
          baselineCommit: made.head,
          baselineBranch: await currentBranch(entry.repo.path),
          taskBranch: made.taskBranch,
          preexistingChanges: [],
          worktreePath: dir,
          isolated: true,
        });
        this.publisher.event(task.id, 'GIT_BASELINE', `${entry.repo.name}: baseline recorded at ${made.head.slice(0, 10)} in an isolated worktree (${entry.folder}/) · your working tree is not touched`, {
          repositoryId: entry.repo.id,
          head: made.head,
          branch: made.taskBranch,
          worktree: dir,
        });
      }
    } catch (error) {
      const reason = redact((error as Error)?.message ?? String(error)).slice(0, 300);
      for (const c of created.reverse()) {
        await removeWorktree(c.entry.repo.path, c.dir, { force: true }).catch(() => false);
        await deleteBranchIfAt(c.entry.repo.path, c.taskBranch, c.head).catch(() => false);
        this.publisher.updateRepositoryGit(task.id, c.entry.repo.id, { baselineSnapshotId: null, baselineCommit: null, baselineBranch: null, taskBranch: null, worktreePath: null });
      }
      await rmdir(workspace).catch(() => undefined);
      const kept = repos.some((r) => r.git.baselineSnapshotId);
      const message = `Could not prepare ${current?.repo.name ?? 'a repository'} for this task: ${reason}. ${kept ? 'Repositories prepared earlier keep their worktrees; your working trees were not changed' : 'Nothing was changed in your repositories'}; resume to try again.`;
      this.publisher.updateTask(task.id, { status: 'WAITING_FOR_USER', blocker: { kind: 'error', message, errorClass: 'UNKNOWN' } });
      this.publisher.event(task.id, 'TASK_WAITING', message);
      return false;
    }
    this.publisher.updateTask(task.id, { git: { ...this.task(task.id).git, workspacePath: workspace } });
    // Every repository, including one prepared before an interruption (an install is skipped when node_modules exists).
    for (const u of taskRepositories(this.d.store, this.task(task.id))) if (u.git.worktreePath) await this.d.tooling.prepareWorktree(this.task(task.id), u.repo, u.git.worktreePath);
    return true;
  }

  /**
   * End a task across repositories: each repository's worktree is finalized
   * (remaining work committed on its branch, or kept in a backup ref when
   * cancelled) and removed, then the empty workspace folder. A worktree that
   * cannot be removed is kept, and so is the workspace; the report says where.
   */
  private async finalizeWorkspace(task: TaskRecord, outcome: 'completed' | 'cancelled'): Promise<TaskRecord> {
    for (const unit of taskRepositories(this.d.store, task)) {
      if (!unit.git.worktreePath) continue;
      const patch = await this.d.tooling.finalizeWorktree(this.task(task.id), unit.repo, outcome, unit.git, unit.repo.name);
      if (Object.keys(patch).length) this.publisher.updateRepositoryGit(task.id, unit.repo.id, patch);
    }
    const workspace = this.task(task.id).git.workspacePath;
    if (workspace) {
      await rmdir(workspace).catch(() => undefined);
      if (!existsSync(workspace)) this.publisher.updateTask(task.id, { git: { ...this.task(task.id).git, workspacePath: null } });
      else {
        const left = await readdir(workspace).catch(() => [] as string[]);
        this.publisher.event(task.id, 'WORKTREE_REMOVED', `The task workspace is kept at ${workspace}: it still holds ${left.slice(0, 10).join(', ') || 'files'}.`);
      }
    }
    return this.task(task.id);
  }

  /** Entries at the root of a task workspace that are not one of its repository folders. */
  private async workspaceStrays(task: TaskRecord): Promise<string[]> {
    const workspace = task.git.workspacePath;
    if (!workspace) return [];
    const folders = new Set(taskRepositories(this.d.store, task).map((u) => u.folder));
    return (await readdir(workspace).catch(() => [] as string[])).filter((name) => !folders.has(name)).sort();
  }

  /** Decide the next step from a stage outcome. Returns true to keep looping. */
  private async handleOutcome(taskId: string, def: StageDefinition, stage: StageInstance, outcome: StageOutcome, control: RunControl): Promise<boolean> {
    const task = this.task(taskId);
    switch (outcome.kind) {
      case 'success':
      case 'skipped': {
        control.autoRetries.delete(def.key);
        if (this.supervises(task)) this.supervisor!.afterSuccess(taskId, def, stage);
        if (def.role === 'planner' && task.mode === 'discuss' && outcome.kind === 'success') {
          const state = this.approvals.state(task.id, 'plan_review', { stageId: outcome.stageId });
          if (state !== 'approved') {
            this.publisher.updateTask(task.id, { currentStageKey: def.next });
            this.approvals.request(this.task(taskId), {
              kind: 'plan_review',
              stageId: outcome.stageId,
              stageKey: def.key,
              requestedBy: stage.agentId ? this.d.agents.adapter(stage.agentId).displayName : 'system',
              action: 'Approve plan and start implementation',
              permissionLevel: 1,
              risk: 'normal',
              reason: 'Discuss First mode: implementation starts only after you approve the plan.',
              riskExplanation: 'Approving lets the workflow continue to implementation. Requesting changes sends your note back to the planner.',
            });
            return false;
          }
        }
        this.publisher.updateTask(task.id, { currentStageKey: def.next });
        return true;
      }
      case 'verdict_fail':
      case 'tests_failed': {
        control.autoRetries.delete(def.key);
        if (this.supervises(task)) {
          // Supervised: the Chairman decides between the local fix loop and a recovery cycle.
          const verdict = await this.supervisor!.onFailure(taskId, def, stage, outcome, control);
          if (verdict === 'continue') return true;
          if (verdict === 'stop') {
            this.afterHook(taskId, control);
            return false;
          }
          const current = this.task(taskId);
          const attempt = current.fixCycles + 1;
          this.publisher.updateTask(taskId, { fixCycles: attempt, currentStageKey: def.onFail });
          this.publisher.event(taskId, 'FIX_CYCLE', `Fix attempt ${attempt} of ${current.maxFixCycles}${current.recoveryCycle ? ` · recovery cycle ${current.recoveryCycle}` : ''}`, { cycle: attempt, recoveryCycle: current.recoveryCycle });
          return true;
        }
        if (!def.onFail) {
          const message = outcome.kind === 'tests_failed' ? outcome.message : `${def.name} did not pass`;
          this.publisher.updateTask(task.id, { status: 'FAILED', blocker: { kind: 'error', message, errorClass: outcome.kind === 'tests_failed' ? 'TEST_FAILURE' : undefined, stageKey: def.key } });
          this.publisher.event(task.id, 'TASK_FAILED', message);
          return false;
        }
        if (task.fixCycles >= task.maxFixCycles) {
          const message = `${def.name} still failing after ${task.maxFixCycles} fix cycle${task.maxFixCycles === 1 ? '' : 's'}. Review the output, add a directive, then resume for one more cycle — or cancel.`;
          this.publisher.updateTask(task.id, { status: 'WAITING_FOR_USER', blocker: { kind: 'fix_limit', message, stageKey: def.key } });
          this.publisher.event(task.id, 'TASK_WAITING', `Fix limit reached (${task.maxFixCycles})`);
          return false;
        }
        const cycle = task.fixCycles + 1;
        this.publisher.updateTask(task.id, { fixCycles: cycle, currentStageKey: def.onFail });
        this.publisher.event(task.id, 'FIX_CYCLE', `Fix cycle ${cycle} of ${task.maxFixCycles} started`, { cycle });
        return true;
      }
      case 'optional_failed': {
        // Recorded and reported; the workflow moves on and nothing is recovered (§3.D).
        control.autoRetries.delete(def.key);
        this.publisher.event(taskId, 'STAGE_OPTIONAL_FAILED', `${def.name} failed and is optional: ${outcome.message}. The task continues; the report lists it.`, { stageKey: def.key, limitation: outcome.limitation ?? `${def.name} (optional) failed: ${outcome.message}` }, stage.id);
        this.publisher.updateTask(taskId, { currentStageKey: def.next });
        return true;
      }
      case 'error':
        return this.handleError(task, def, stage, outcome, control);
      case 'blocked':
        return false;
      case 'goto': {
        control.autoRetries.delete(def.key);
        this.publisher.updateTask(taskId, { currentStageKey: outcome.stageKey });
        this.publisher.event(taskId, 'TASK_REDIRECTED', `Redirected to ${this.d.views.stageDef(task, outcome.stageKey)?.name ?? outcome.stageKey} · ${outcome.message}`, { stageKey: outcome.stageKey }, stage.id);
        return true;
      }
      case 'needs_operator': {
        // Not a failure: no fix loop or recovery can settle a question only the operator may answer.
        const message = outcome.questions.length === 1 ? outcome.questions[0]! : outcome.questions.map((q, i) => `(${i + 1}) ${q}`).join(' ');
        this.publisher.updateTask(task.id, { status: 'WAITING_FOR_USER', blocker: { kind: 'decision', message, stageKey: def.key }, pauseRequested: false, pauseAfterStage: false });
        this.publisher.event(task.id, 'TASK_WAITING', `${def.name} needs your decision: ${message.length > 300 ? `${message.slice(0, 299)}…` : message}`, { questions: outcome.questions }, stage.id);
        return false;
      }
      case 'stopped':
        if (outcome.reason === 'watchdog') {
          // A stuck or dead worker is a failed attempt, not a pause.
          const message = control.watchdogReason ?? 'Stopped by the watchdog';
          control.stopReason = null;
          control.watchdogReason = null;
          const failed = this.stages.failStage(stage, 'TIMEOUT', message) as Extract<StageOutcome, { kind: 'error' }>;
          this.publisher.event(taskId, 'WATCHDOG', message, {}, stage.id);
          return this.handleError(this.task(taskId), def, stage, failed, control);
        }
        if (outcome.reason === 'reroute') {
          this.publisher.updateStage(stage.id, { status: 'CANCELLED', summary: 'Rerouted to another agent', finishedAt: now() });
          control.stopReason = null;
          return true;
        }
        this.stopped(task, outcome.reason, stage);
        return false;
    }
  }

  private async handleError(task: TaskRecord, def: StageDefinition, stage: StageInstance, outcome: Extract<StageOutcome, { kind: 'error' }>, control: RunControl): Promise<boolean> {
    const label = ERROR_CLASS_LABEL[outcome.errorClass];
    const blocking = ['USAGE_LIMIT', 'AUTH_FAILURE', 'MODEL_UNAVAILABLE', 'PERMISSION_DENIED', 'CONTEXT_FAILURE'].includes(outcome.errorClass);
    const retriesLeft = !blocking && (control.autoRetries.get(def.key) ?? 0) + 1 < def.retry.maxAttempts;
    if (this.supervises(task) && !retriesLeft) {
      const verdict = await this.supervisor!.onError(task.id, def, stage, outcome, control, blocking ? 'blocked' : 'exhausted');
      if (verdict === 'continue') {
        control.autoRetries.delete(def.key);
        return true;
      }
      if (verdict === 'stop') {
        this.afterHook(task.id, control);
        return false;
      }
    }
    const waitFor = (status: TaskStatus, blocker: TaskBlocker, message: string) => {
      this.publisher.updateTask(task.id, { status, blocker });
      this.publisher.event(task.id, 'TASK_WAITING', message);
      return false;
    };
    switch (outcome.errorClass) {
      case 'USAGE_LIMIT':
        // Never switch to paid API usage: wait for the subscription allowance to return.
        return waitFor(
          'WAITING_FOR_USAGE_RESET',
          { kind: 'usage', message: `${outcome.message} — paused; no paid API fallback. Resume when the limit resets, or reroute the stage.`, errorClass: 'USAGE_LIMIT', stageKey: def.key },
          `${def.name} paused: usage limit reached`,
        );
      case 'AUTH_FAILURE':
        return waitFor('WAITING_FOR_USER', { kind: 'auth', message: outcome.message, errorClass: 'AUTH_FAILURE', stageKey: def.key }, `${def.name} blocked: ${label}`);
      case 'MODEL_UNAVAILABLE':
      case 'PERMISSION_DENIED':
      case 'CONTEXT_FAILURE':
        return waitFor('WAITING_FOR_USER', { kind: 'error', message: outcome.message, errorClass: outcome.errorClass, stageKey: def.key }, `${def.name} blocked: ${label}`);
      default: {
        const used = control.autoRetries.get(def.key) ?? 0;
        if (used + 1 < def.retry.maxAttempts) {
          control.autoRetries.set(def.key, used + 1);
          this.publisher.event(task.id, 'STAGE_RETRY', `Retrying ${def.name} (attempt ${used + 2} of ${def.retry.maxAttempts}) after: ${label}`);
          return true;
        }
        control.autoRetries.delete(def.key);
        this.publisher.updateTask(task.id, { status: 'FAILED', blocker: { kind: 'error', message: outcome.message, errorClass: outcome.errorClass, stageKey: def.key } });
        this.publisher.event(task.id, 'TASK_FAILED', `${def.name} failed: ${label}`);
        return false;
      }
    }
  }

  /** Apply a stop requested by the user or by shutdown. */
  private stopped(task: TaskRecord, reason: StopReason, stage: StageInstance | null): void {
    if (reason === 'cancel') return; // cancel() finalises statuses itself
    const control = this.runners.get(task.id)?.control;
    if (reason === 'redirect' && control?.redirect) {
      this.applyPlan(task, control.redirect, stage);
      return;
    }
    const current = stage ?? (task.currentStageId ? this.d.store.getStage(task.currentStageId) : null);
    const active = current && ['STARTING', 'RUNNING', 'RETRYING'].includes(current.status);
    if (reason === 'pause' || reason === 'redirect') {
      if (active) this.publisher.updateStage(current.id, { status: 'PAUSED', finishedAt: now() });
      this.publisher.updateTask(task.id, { status: 'PAUSED', pauseRequested: false, pauseAfterStage: false });
      this.publisher.event(task.id, 'TASK_PAUSED', active ? `Paused during ${current.name}; it will run again on resume` : 'Task paused');
      return;
    }
    if (active) this.publisher.updateStage(current.id, { status: 'INTERRUPTED', finishedAt: now() });
    if (!active && this.draining) {
      // A drain stops between stages: nothing was cut off, and the next stage runs after the restart.
      const next = this.d.views.stageDef(task, task.currentStageKey);
      this.publisher.updateTask(task.id, {
        status: 'INTERRUPTED',
        blocker: { kind: 'interrupted', message: `Stopped between stages for a restart; ${next?.name ?? 'the next stage'} runs when the orchestrator is back. Resume if it does not start by itself.`, stageKey: task.currentStageKey ?? undefined },
      });
      this.publisher.event(task.id, 'TASK_INTERRUPTED', `Stopped at a stage boundary for a restart, before ${next?.name ?? 'the next stage'}`);
      return;
    }
    this.publisher.updateTask(task.id, {
      status: 'INTERRUPTED',
      blocker: { kind: 'interrupted', message: `The orchestrator stopped${current ? ` during ${current.name}` : ''}. Resume to run it again.`, stageKey: current?.stageKey },
    });
    this.publisher.event(task.id, 'TASK_INTERRUPTED', `Interrupted by orchestrator shutdown${current ? ` during ${current.name}` : ''}`);
  }

  private async complete(task: TaskRecord, gateLimitations: string[] = []): Promise<void> {
    const repo = this.d.repositories.record(task.repositoryId);
    const units = taskRepositories(this.d.store, task);
    const multi = units.length > 1;
    const baseline = task.git.baselineSnapshotId ? this.d.store.getSnapshot(task.git.baselineSnapshotId) : null;
    const workdir = taskWorkdir(task, repo);
    let files: ChangedFile[] | null = null;
    if (multi) {
      // One patch for the whole task: every repository's diff, paths under its folder.
      files = [];
      const parts: string[] = [];
      for (const unit of units) {
        const unitBaseline = unit.git.baselineSnapshotId ? this.d.store.getSnapshot(unit.git.baselineSnapshotId) : null;
        if (!unitBaseline) continue;
        try {
          files.push(...(await changesSince(unit.workdir, unitBaseline)).map((f) => ({ ...f, path: inFolder(unit.folder, f.path), repositoryId: unit.repo.id })));
          const { diff, truncated } = await diffSince(unit.workdir, unitBaseline, { maxBytes: 5_000_000, prefix: unit.folder });
          if (diff) parts.push(truncated ? `${diff}\n[truncated]` : diff);
        } catch (error) {
          this.publisher.event(task.id, 'FILE_CHANGED', `${unit.repo.name}: final diff could not be captured: ${(error as Error).message}`);
        }
      }
      await this.d.artifacts.write(task.id, { name: 'git-diff.patch', type: 'git-diff', content: parts.map((d) => (d.endsWith('\n') ? d : `${d}\n`)).join('') });
    } else if (baseline) {
      try {
        files = await changesSince(workdir, baseline);
        const { diff, truncated } = await diffSince(workdir, baseline, { maxBytes: 5_000_000 });
        await this.d.artifacts.write(task.id, { name: 'git-diff.patch', type: 'git-diff', content: truncated ? `${diff}\n[truncated]` : diff });
      } catch (error) {
        this.publisher.event(task.id, 'FILE_CHANGED', `Final diff could not be captured: ${(error as Error).message}`);
      }
    }
    const stages = this.d.store.listStages(task.id);
    const testsSkipped = stages.some((s) => s.kind === 'tests' && s.status === 'SKIPPED');
    const release = this.task(task.id).git.release ?? null;
    const deployed = release?.state === 'live' ? 'production' : stages.some((s) => s.kind === 'command' && s.status === 'SUCCESS' && s.role === 'deployer') ? 'staging' : 'none';
    const operatorItems = latestOperatorItems(
      await this.d.artifacts.latestText(task.id, 'review'),
      await this.d.artifacts.latestText(task.id, 'verification'),
    );
    // Nothing the task started outlives it; an isolated task's work lands on its branch.
    const cleanup = await this.d.tooling.cleanup(task, repo, 'task completed');
    if (multi) {
      // Anything written at the workspace root is in no repository, so on no task branch: say so, never READY.
      const strays = await this.workspaceStrays(task);
      if (strays.length) gateLimitations = [...gateLimitations, `${strays.length} item(s) were written outside every repository folder and are on no task branch: ${strays.slice(0, 10).join(', ')}${strays.length > 10 ? ', …' : ''}.`];
      task = await this.finalizeWorkspace(task, 'completed');
    } else if (task.git.worktreePath) {
      const git = await this.d.tooling.finalizeWorktree(task, repo, 'completed');
      if (Object.keys(git).length) this.publisher.updateTask(task.id, { git: { ...this.task(task.id).git, ...git } });
      task = this.task(task.id);
    }
    const testRuns = this.d.store.listTestRuns(task.id);
    gateLimitations = [...gateLimitations, ...optionalFailures(this.d.store.listEvents(task.id, { limit: 5000 }), stages)];
    const verification = this.d.tooling.verificationCoverage(task, repo, stages, testRuns);
    const repositories = multi ? taskRepositories(this.d.store, task).map((u) => ({ name: u.repo.name, path: u.repo.path, folder: u.folder, git: u.git })) : undefined;
    // Measured up to now, the moment the task completes (LEAD_TIME_PLAN §3.3); it never throws.
    const time = taskTimeBreakdown(this.d.store, this.task(task.id));
    const report = buildFinalReport({
      task,
      repo,
      stages,
      testRuns,
      files,
      testsSkipped,
      deployed,
      release,
      operatorItems,
      gateLimitations,
      verification,
      repositories,
      browserRechecks: this.d.store.listArtifacts(task.id).filter((a) => a.type === 'operator-evidence').map((a) => a.name),
      executionLines: [...this.d.tooling.reportSection(task), ...cleanup.map((l) => `- ${l}`)],
      timeLines: timeBreakdownLines({ ...time, finished: true }),
      waivers: this.d.store
        .listDirectives(task.id)
        .filter((d) => d.state === 'active' && d.rule?.type === 'waive_check')
        .map((d) => ({ kinds: (d.rule as { kinds: string[] }).kinds, text: d.text })),
    });
    await this.d.artifacts.write(task.id, { name: 'final-report.md', type: 'final-report', content: report.markdown });
    const finishedAt = now();
    const completion = { status: 'COMPLETED' as const, finalStatus: report.finalStatus, blocker: null, finishedAt, currentStageKey: COMPLETE };
    // Every artifact exists before COMPLETED is published, so a client that
    // reacts to the status never sees a report without its task record.
    await this.d.artifacts.write(task.id, {
      name: 'task.json',
      type: 'task-json',
      content: JSON.stringify({ ...this.d.views.detail({ ...this.task(task.id), ...completion, updatedAt: finishedAt }), timeBreakdown: { ...time, finished: true }, events: this.d.store.listEvents(task.id, { limit: 2000 }) }, null, 2),
    });
    this.publisher.updateTask(task.id, completion);
    this.publisher.event(task.id, 'TASK_COMPLETED', report.finalStatus === 'READY' ? 'Task completed · ready' : `Task completed · needs your attention: ${report.limitations[0]}`, {
      finalStatus: report.finalStatus,
    });
    this.supervisor?.onTerminal(task.id);
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Restart recovery (PLAN §32): anything that was running when the process
   * died is marked INTERRUPTED with an explanation; nothing is resumed
   * without the user. Queued tasks simply wait for the scheduler.
   */
  recover(): { interruptedTasks: string[] } {
    const { store } = this.d;
    const ts = now();
    for (const exec of store.executionsWithStatus('running')) {
      store.updateExecution(exec.id, { status: 'interrupted', finishedAt: ts, errorMessage: 'Orchestrator stopped during execution' });
    }
    for (const run of store.testRunsWithStatus('running')) store.updateTestRun(run.id, { status: 'not_run', summary: 'Interrupted', finishedAt: ts });
    for (const stage of store.stagesWithStatus(['STARTING', 'RUNNING', 'RETRYING'])) store.updateStage(stage.id, { status: 'INTERRUPTED', finishedAt: ts });
    const interrupted: string[] = [];
    for (const task of store.listTasks({ statuses: ['RUNNING'], limit: 10_000 })) {
      const stage = task.currentStageId ? store.getStage(task.currentStageId) : null;
      store.updateTask(task.id, {
        status: 'INTERRUPTED',
        pauseRequested: false,
        blocker: { kind: 'interrupted', message: `The orchestrator restarted while ${stage?.name ?? 'the task'} was running. Resume to run it again, or retry an earlier stage.`, stageKey: stage?.stageKey },
      });
      this.publisher.event(task.id, 'TASK_INTERRUPTED', `Interrupted: the orchestrator restarted during ${stage?.name ?? 'the task'}`);
      interrupted.push(task.id);
    }
    // Tasks parked on an approval keep waiting; make sure their blocker still points at it.
    for (const task of store.listTasks({ statuses: ['WAITING_FOR_USER'], limit: 10_000 })) {
      if (task.blocker?.kind !== 'approval' || !task.blocker.approvalId) continue;
      const approval = store.getApproval(task.blocker.approvalId);
      if (approval?.status !== 'pending') {
        store.updateTask(task.id, { status: 'QUEUED', blocker: null });
        continue;
      }
      // A stage whose commands were removed while it waited would only be
      // skipped; asking for approval of it is noise.
      const def = approval.kind === 'stage_permission' && approval.stageKey ? this.d.views.stageDef(task, approval.stageKey) : null;
      const repo = def ? store.getRepository(task.repositoryId) : null;
      const nothing = def && repo ? (def.kind === 'release' ? this.release.skipReason(task, repo) : skipsForLackOfCommands(def, taskRepositories(store, task).map((r) => r.repo)) ? `${def.name} has no command configured` : null) : null;
      if (def && nothing) {
        const cancelled = store.resolveApproval(approval.id, 'cancelled', `${nothing}; it will be skipped`);
        this.d.bus.publish({ type: 'approval', approval: this.d.views.approval(cancelled) });
        store.updateTask(task.id, { status: 'QUEUED', blocker: null });
        this.publisher.event(task.id, 'APPROVAL_RESOLVED', `Approval withdrawn: ${def.name} has nothing to run (${nothing})`, { approvalId: approval.id });
      }
    }
    return { interruptedTasks: interrupted };
  }

  /** Graceful shutdown: stop every execution and mark running tasks INTERRUPTED. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all([...this.runners.keys()].map((id) => this.stop(id, 'shutdown')));
  }
}

/** Optional stages whose latest run failed, as report limitations (a later success clears one). */
export function optionalFailures(events: Array<{ type: string; data?: Record<string, unknown> | null; stageId?: string | null }>, stages: StageInstance[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type !== 'STAGE_OPTIONAL_FAILED') continue;
    const key = e.data?.stageKey as string | undefined;
    const limitation = e.data?.limitation as string | undefined;
    const latest = stages.filter((s) => s.stageKey === key).at(-1);
    if (limitation && latest?.id === e.stageId && !out.includes(limitation)) out.push(limitation);
  }
  return out;
}

export function deriveTitle(description: string): string {
  const first = description
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s]+/, '').trim())
    .find(Boolean) ?? 'Untitled task';
  const sentence = first.split(/(?<=[.!?])\s/)[0] ?? first;
  return sentence.length > 80 ? `${sentence.slice(0, 79)}…` : sentence;
}
