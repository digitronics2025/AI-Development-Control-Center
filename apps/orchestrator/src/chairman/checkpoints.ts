import { createCheckpoint, deleteRefs, headCommit, isGitRepository, restoreCheckpoint, type RestoreResult } from '@acc/git';
import { redact } from '@acc/security';
import type { Bus } from '../bus.js';
import { EngineError } from '../engine/engine.js';
import type { Publisher } from '../engine/publisher.js';
import type { RepositoryService } from '../services/repositories.js';
import { newId, now, type Store, type TaskRecord } from '../store/store.js';
import type { CheckpointRecord, ChairmanStore } from './store.js';

export type CheckpointReason = 'before-stage' | 'recovery-pivot' | 'user' | 'before-rollback';

/**
 * Task checkpoints (plan §3.18, §15) on top of the task's Git baseline. A
 * rollback restores only files the task owns: anything that held
 * uncommitted user work at the baseline is left exactly as it is, and a
 * rollback across a commit is refused rather than attempted.
 */
export class CheckpointService {
  constructor(
    private readonly store: Store,
    private readonly chairman: ChairmanStore,
    private readonly repositories: RepositoryService,
    private readonly publisher: Publisher,
    private readonly bus: Bus,
  ) {}

  private async repoPath(task: TaskRecord): Promise<string | null> {
    if (!task.git.baselineSnapshotId) return null;
    const repo = this.store.getRepository(task.repositoryId);
    if (!repo || !(await isGitRepository(repo.path))) return null;
    return repo.path;
  }

  /** Null when the task has no Git baseline yet (nothing it could have changed). */
  async create(task: TaskRecord, opts: { label: string; reason: CheckpointReason; stageKey?: string | null }): Promise<CheckpointRecord | null> {
    const cwd = await this.repoPath(task);
    if (!cwd) return null;
    const seq = this.chairman.nextCheckpointSeq(task.id);
    const ref = `refs/acc/checkpoints/${task.id}/${seq}`;
    const cp = await createCheckpoint(cwd, ref, `${task.id} checkpoint ${seq}: ${opts.label}`);
    const rec = this.chairman.insertCheckpoint({
      id: newId(),
      taskId: task.id,
      seq,
      label: redact(opts.label).slice(0, 120),
      reason: opts.reason,
      commit: cp.commit,
      ref,
      head: cp.head,
      stageKey: opts.stageKey ?? null,
      createdAt: now(),
    });
    this.bus.publish({ type: 'checkpoint', checkpoint: rec });
    this.publisher.event(task.id, 'CHECKPOINT_CREATED', `Checkpoint ${seq}: ${rec.label}`, { checkpointId: rec.id, seq, reason: opts.reason });
    return rec;
  }

  /**
   * The checkpoint taken just before the most recent write stage started:
   * restoring it undoes "the last change".
   */
  lastChangeTarget(task: TaskRecord): CheckpointRecord | null {
    const lastWrite = [...this.store.listStages(task.id)].reverse().find((s) => (s.role === 'implementer' || s.role === 'fixer') && s.status !== 'PAUSED');
    const auto = this.chairman.listCheckpoints(task.id).filter((c) => c.reason === 'before-stage');
    if (!lastWrite) return auto.at(-1) ?? null;
    return [...auto].reverse().find((c) => c.createdAt <= lastWrite.createdAt) ?? null;
  }

  async restore(task: TaskRecord, checkpointId?: string): Promise<{ checkpoint: CheckpointRecord; result: RestoreResult }> {
    const cwd = await this.repoPath(task);
    if (!cwd) throw new EngineError('Rollback needs a Git repository and a recorded baseline; this task has neither.', 'INVALID_STATE');
    const target = checkpointId ? this.chairman.checkpoint(checkpointId) : this.lastChangeTarget(task);
    if (!target || target.taskId !== task.id) throw new EngineError(checkpointId ? 'Checkpoint not found' : 'There is no checkpoint before the last change to roll back to.', checkpointId ? 'NOT_FOUND' : 'INVALID_STATE');
    const head = await headCommit(cwd);
    if (head !== target.head) {
      throw new EngineError(`Rollback refused: the branch has new commits since checkpoint ${target.seq}, and rolling back across a commit could lose work. Revert that commit instead.`, 'INVALID_STATE');
    }
    // The rollback itself stays undoable.
    await this.create(task, { label: `Before rolling back to checkpoint ${target.seq}`, reason: 'before-rollback', stageKey: task.currentStageKey });
    const userOwned = new Set(task.git.preexistingChanges);
    const result = await restoreCheckpoint(cwd, target.commit, (p) => !userOwned.has(p));
    this.publisher.event(
      task.id,
      'ROLLBACK_COMPLETED',
      `Rolled back to checkpoint ${target.seq} (${target.label}): ${result.restored.length} restored, ${result.removed.length} removed${result.skipped.length ? `, ${result.skipped.length} of your own files left untouched` : ''}`,
      { checkpointId: target.id, ...result },
    );
    this.repositories.invalidate(task.repositoryId);
    return { checkpoint: target, result };
  }

  /** Drop the hidden refs once the task is finished; the rows stay as history. */
  async prune(task: TaskRecord): Promise<void> {
    const repo = this.store.getRepository(task.repositoryId);
    if (!repo || !this.chairman.listCheckpoints(task.id).length) return;
    try {
      await deleteRefs(repo.path, `refs/acc/checkpoints/${task.id}/`);
    } catch {
      /* repository moved or deleted: nothing to clean */
    }
  }
}
