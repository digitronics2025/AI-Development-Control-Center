import type { StageDefinition, StageInstance, TaskLimits } from '@acc/shared';
import type { TaskRecord } from '../store/store.js';
import type { RunControl, StageOutcome } from './runners.js';

/**
 * The points at which the engine consults the Chairman for a supervised task
 * (docs/systems/chairman.md). The engine stays the only writer of workflow
 * state: hooks decide, and anything they change goes back through the
 * Action Gateway into engine methods. Unsupervised tasks never call these.
 */
export interface SupervisorHooks {
  /** New task: contract and session. */
  onTaskCreated(task: TaskRecord): void;
  /** Before a stage starts: limits and checkpoints. False = the task was parked; stop the loop. */
  beforeStage(task: TaskRecord, def: StageDefinition, control: RunControl): Promise<boolean>;
  /** A stage succeeded: failures it resolves count as progress. */
  afterSuccess(taskId: string, def: StageDefinition, stage: StageInstance): void;
  /**
   * Tests failed or a verdict was FAIL. `local_fix` = take the workflow's
   * onFail route as usual; `continue` = a recovery strategy was applied;
   * `stop` = the task was parked (hard blocker, limit) or stopped.
   */
  onFailure(taskId: string, def: StageDefinition, stage: StageInstance, outcome: Extract<StageOutcome, { kind: 'verdict_fail' | 'tests_failed' }>, control: RunControl): Promise<'local_fix' | 'continue' | 'stop'>;
  /**
   * A stage errored and deterministic retries are used up (`exhausted`), or it
   * hit a provider block (`blocked`). `legacy` = handle as an unsupervised task.
   */
  onError(taskId: string, def: StageDefinition, stage: StageInstance, outcome: Extract<StageOutcome, { kind: 'error' }>, control: RunControl, mode: 'exhausted' | 'blocked'): Promise<'continue' | 'stop' | 'legacy'>;
  /** The workflow reached `complete`: the completion gate decides. */
  beforeComplete(taskId: string, control: RunControl): Promise<{ kind: 'complete'; limitations: string[] } | { kind: 'continue' } | { kind: 'stop' }>;
  /** The user resumed the task (from any waiting state), before it is queued. */
  onResume(task: TaskRecord): void;
  /** Limits after the user resumes a task parked at one. */
  extendedLimits(task: TaskRecord): TaskLimits;
  /** Completed or cancelled. */
  onTerminal(taskId: string): void;
}
