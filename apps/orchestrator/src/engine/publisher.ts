import { redact } from '@acc/security';
import type { EventType, StageInstance, TaskEvent } from '@acc/shared';
import type { Bus } from '../bus.js';
import { now, type Store, type TaskRecord } from '../store/store.js';
import type { TaskViews } from './views.js';

/** Event types that become the task's "last meaningful event". */
const MEANINGFUL = new Set<EventType>([
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
  'STAGE_SKIPPED',
  'STAGE_RETRY',
  'TEST_FAILED',
  'TEST_PASSED',
  'REVIEW_PASSED',
  'REVIEW_FAILED',
  'FIX_CYCLE',
  'REROUTED',
  'APPROVAL_REQUESTED',
  'APPROVAL_RESOLVED',
  'GIT_COMMIT',
  'TASK_COMPLETED',
  'TASK_FAILED',
]);

/**
 * The single write path for the task event log and realtime updates. Every
 * change the engine makes goes through here, so the dashboard and VS Code see
 * the same sequence the database records.
 */
export class Publisher {
  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly views: TaskViews,
  ) {}

  event(taskId: string, type: EventType, message: string, data: Record<string, unknown> = {}, stageId: string | null = null): TaskEvent {
    const event = this.store.insertEvent({ taskId, type, stageId, message: redact(message), data, at: now() });
    this.bus.publish({ type: 'event', event });
    if (MEANINGFUL.has(type)) {
      this.store.updateTask(taskId, { lastEvent: { type, message: event.message, at: event.at } });
    }
    this.task(taskId);
    return event;
  }

  task(taskOrId: string | TaskRecord): void {
    const task = typeof taskOrId === 'string' ? this.store.getTask(taskOrId) : taskOrId;
    if (task) this.bus.publish({ type: 'task', task: this.views.summary(task) });
  }

  stage(stage: StageInstance): void {
    this.bus.publish({ type: 'stage', stage });
  }

  /** Update a task and publish the new summary. */
  updateTask(taskId: string, patch: Partial<TaskRecord>): TaskRecord {
    const task = this.store.updateTask(taskId, patch);
    this.task(task);
    return task;
  }

  /** Update one repository's Git record of a task (the primary's is `tasks.git`) and publish the new summary. */
  updateRepositoryGit(taskId: string, repositoryId: string, patch: Partial<TaskRecord['git']>): TaskRecord {
    const task = this.store.getTask(taskId)!;
    if (repositoryId === task.repositoryId) return this.updateTask(taskId, { git: { ...task.git, ...patch } });
    const linked = this.store.listLinkedRepositories(taskId).find((l) => l.repositoryId === repositoryId);
    if (!linked) throw new Error(`${taskId} does not work in repository ${repositoryId}`);
    this.store.updateLinkedRepositoryGit(taskId, repositoryId, { ...linked.git, ...patch });
    const updated = this.store.getTask(taskId)!;
    this.task(updated);
    return updated;
  }

  updateStage(stageId: string, patch: Partial<StageInstance>): StageInstance {
    const stage = this.store.updateStage(stageId, patch);
    this.stage(stage);
    return stage;
  }
}
