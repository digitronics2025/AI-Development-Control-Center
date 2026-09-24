import {
  ATTENTION_TASK_STATUSES,
  COMPLETE,
  resolveAssignment,
  workflowHappyPath,
  type Approval,
  type OverviewCounts,
  type ResolvedAssignment,
  type StageDefinition,
  type StageInstance,
  type TaskDetail,
  type TaskSummary,
} from '@acc/shared';
import type { SettingsService } from '../services/settings.js';
import type { ApprovalRecord, Store, TaskRecord } from '../store/store.js';

const DONE_STAGE = new Set(['SUCCESS', 'SKIPPED']);

/** Read-side projections of task state for the API and WebSocket. */
export class TaskViews {
  constructor(
    private readonly store: Store,
    private readonly settings: SettingsService,
  ) {}

  stageDef(task: TaskRecord, key: string | null): StageDefinition | null {
    if (!key) return null;
    return task.workflow.stages.find((s) => s.key === key) ?? null;
  }

  assignmentFor(task: TaskRecord, def: StageDefinition): ResolvedAssignment {
    const repo = this.store.getRepository(task.repositoryId);
    return resolveAssignment(def, {
      roleDefaults: this.settings.get().roleDefaults,
      repositoryOverrides: repo?.roleOverrides,
      taskOverrides: task.overrides,
    });
  }

  assignments(task: TaskRecord): Record<string, ResolvedAssignment> {
    const out: Record<string, ResolvedAssignment> = {};
    for (const def of task.workflow.stages) if (def.kind === 'agent') out[def.key] = this.assignmentFor(task, def);
    return out;
  }

  summary(task: TaskRecord, stages: StageInstance[] = this.store.listStages(task.id)): TaskSummary {
    const repo = this.store.getRepository(task.repositoryId);
    const happy = workflowHappyPath(task.workflow);
    const latest = new Map<string, StageInstance>();
    for (const s of stages) latest.set(s.stageKey, s);
    const completed = happy.filter((d) => {
      const s = latest.get(d.key);
      return s && DONE_STAGE.has(s.status) && s.verdict !== 'FAIL';
    }).length;
    const currentKey = task.currentStageKey;
    const def = this.stageDef(task, currentKey);
    const currentInstance = task.currentStageId ? stages.find((s) => s.id === task.currentStageId) ?? null : null;
    let currentAssignment: ResolvedAssignment | null = null;
    if (currentInstance && currentInstance.stageKey === currentKey && currentInstance.agentId) {
      currentAssignment = { agentId: currentInstance.agentId, model: currentInstance.model ?? 'default', effort: currentInstance.effort ?? 'default' };
    } else if (def?.kind === 'agent') {
      currentAssignment = this.assignmentFor(task, def);
    }
    const index = happy.findIndex((d) => d.key === currentKey);
    return {
      id: task.id,
      title: task.title,
      repositoryId: task.repositoryId,
      repositoryName: repo?.name ?? 'Unknown repository',
      repositories: [{ id: task.repositoryId, name: repo?.name ?? 'Unknown repository', folder: task.git.folder ?? null, primary: true }],
      workflowId: task.workflowId,
      workflowName: task.workflow.name,
      mode: task.mode,
      status: task.status,
      currentStageKey: currentKey,
      currentStageId: task.currentStageId,
      currentStageName: currentKey === COMPLETE ? 'Complete' : (def?.name ?? null),
      currentAssignment,
      stageProgress: {
        total: happy.length,
        completed: task.status === 'COMPLETED' ? happy.length : completed,
        currentIndex: index >= 0 ? index : null,
      },
      fixCycles: task.fixCycles,
      supervised: task.supervised,
      recoveryCycle: task.recoveryCycle,
      version: task.version,
      blocker: task.blocker,
      lastEvent: task.lastEvent,
      finalStatus: task.finalStatus,
      pauseRequested: task.pauseRequested,
      pauseAfterStage: task.pauseAfterStage,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      updatedAt: task.updatedAt,
    };
  }

  detail(task: TaskRecord): TaskDetail {
    const stages = this.store.listStages(task.id);
    return {
      ...this.summary(task, stages),
      description: task.description,
      policyMode: task.policyMode ?? this.settings.get().execution.policyMode,
      workflow: task.workflow,
      overrides: task.overrides,
      autoApproveUpToLevel: task.autoApproveUpToLevel,
      maxFixCycles: task.maxFixCycles,
      git: {
        baselineCommit: task.git.baselineCommit,
        baselineBranch: task.git.baselineBranch,
        taskBranch: task.git.taskBranch,
        preexistingChanges: task.git.preexistingChanges,
        commits: task.git.commits,
        worktreePath: task.git.worktreePath ?? null,
        isolated: task.git.isolated ?? false,
      },
      attachments: task.attachments,
      assignments: this.assignments(task),
      stages,
    };
  }

  approval(rec: ApprovalRecord): Approval {
    const task = this.store.getTask(rec.taskId);
    const repo = task ? this.store.getRepository(task.repositoryId) : null;
    const def = task ? this.stageDef(task, rec.stageKey) : null;
    return {
      ...rec,
      taskTitle: task?.title ?? rec.taskId,
      repositoryName: repo?.name ?? 'Unknown repository',
      stageName: def?.name ?? null,
    };
  }

  overview(): OverviewCounts {
    const counts = this.store.countTasksByStatus();
    const sum = (statuses: readonly string[]) => statuses.reduce((n, s) => n + (counts[s] ?? 0), 0);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return {
      active: sum(['RUNNING', 'QUEUED']),
      waitingForMe: sum(['WAITING_FOR_USER', 'WAITING_FOR_USAGE_RESET', 'INTERRUPTED', 'PAUSED']),
      failed: sum(['FAILED']),
      completedToday: this.store.countCompletedSince(startOfDay.toISOString()),
      pendingApprovals: this.store.listApprovals({ status: 'pending' }).length,
    };
  }

  needsAttention(task: TaskRecord): boolean {
    return ATTENTION_TASK_STATUSES.includes(task.status);
  }
}
