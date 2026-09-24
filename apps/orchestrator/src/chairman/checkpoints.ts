import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { checkpointMetadata, createCheckpoint, deleteRefs, headCommit, isGitRepository, restoreCheckpoint, type RestoreResult } from '@acc/git';
import { redact } from '@acc/security';
import type { Bus } from '../bus.js';
import { EngineError } from '../engine/engine.js';
import type { Publisher } from '../engine/publisher.js';
import type { RepositoryCoordinator } from '../services/repository-coordinator.js';
import type { RepositoryService } from '../services/repositories.js';
import { newId, now, type Store, type TaskRecord } from '../store/store.js';
import { agentWorkdir, taskRepositories, type TaskRepository } from '../engine/task-repositories.js';
import { taskWorkdir } from '../engine/workdir.js';
import type { TaskCheckpointPart } from '@acc/shared';
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
    private readonly coordinator?: RepositoryCoordinator,
  ) {}

  /**
   * Run a rollback holding the writer lock of every repository it rewrites, so a
   * Source Control commit can never interleave with a half-restored tree (audit
   * F-10). A repository this task already holds (a stage is running) is not
   * taken twice; an isolated task works in its own worktree and needs none.
   */
  private async asWriter<T>(task: TaskRecord, fn: () => Promise<T>): Promise<T> {
    if (!this.coordinator || task.git.isolated) return fn();
    const repoIds = [...new Set(taskRepositories(this.store, task).map((u) => u.repo.id))];
    const releases: Array<() => void> = [];
    try {
      for (const id of repoIds) {
        if (this.coordinator.activeWriters(id).some((w) => w.taskId === task.id)) continue;
        releases.push(await this.coordinator.acquireWriter(id, task.id, 'Rollback'));
      }
      return await fn();
    } finally {
      for (const release of releases) release();
    }
  }

  /** The task's working directory (its worktree when isolated), when it has a Git baseline. */
  private async repoPath(task: TaskRecord): Promise<string | null> {
    if (!task.git.baselineSnapshotId) return null;
    const repo = this.store.getRepository(task.repositoryId);
    if (!repo) return null;
    const cwd = taskWorkdir(task, repo);
    return (await isGitRepository(cwd)) ? cwd : null;
  }

  /** A task across repositories: every repository with a baseline, primary first; null for a single-repository task. */
  private workspaceUnits(task: TaskRecord): TaskRepository[] | null {
    const units = taskRepositories(this.store, task);
    if (units.length <= 1) return null;
    return units.filter((u) => u.git.baselineSnapshotId);
  }

  /** Where a database checkpoint's file must be: the task workspace across repositories, else the working directory. */
  private async databaseRoot(task: TaskRecord): Promise<string | null> {
    const units = this.workspaceUnits(task);
    if (!units) return this.repoPath(task);
    const repo = this.store.getRepository(task.repositoryId);
    return units.length && repo ? agentWorkdir(task, repo) : null;
  }

  /**
   * One checkpoint across every repository of the task, under the same ref
   * name in each. If one repository cannot be checkpointed, the refs already
   * made are deleted again and the error is thrown: a checkpoint is all or
   * nothing.
   */
  private async createAcross(task: TaskRecord, units: TaskRepository[], opts: { label: string; reason: CheckpointReason; stageKey?: string | null }): Promise<CheckpointRecord | null> {
    if (!units.length) return null;
    const seq = this.chairman.nextCheckpointSeq(task.id);
    const ref = `refs/acc/checkpoints/${task.id}/${seq}`;
    const parts: TaskCheckpointPart[] = [];
    try {
      for (const u of units) {
        const cp = await createCheckpoint(u.workdir, ref, `${task.id} checkpoint ${seq}: ${opts.label}`);
        parts.push({ repositoryId: u.repo.id, folder: u.folder, ref, commit: cp.commit, head: cp.head });
      }
    } catch (error) {
      for (const p of parts) {
        const u = units.find((x) => x.repo.id === p.repositoryId)!;
        await deleteRefs(u.repo.path, ref).catch(() => undefined);
      }
      throw error;
    }
    const metadata = await checkpointMetadata(units[0]!.workdir).catch(() => ({}));
    const rec = this.chairman.insertCheckpoint({
      type: 'git',
      metadata,
      parts,
      id: newId(),
      taskId: task.id,
      seq,
      label: redact(opts.label).slice(0, 120),
      reason: opts.reason,
      commit: parts[0]!.commit,
      ref,
      head: parts[0]!.head,
      stageKey: opts.stageKey ?? null,
      createdAt: now(),
    });
    this.bus.publish({ type: 'checkpoint', checkpoint: rec });
    this.publisher.event(task.id, 'CHECKPOINT_CREATED', `Checkpoint ${seq}: ${rec.label} (${parts.length} repositories)`, { checkpointId: rec.id, seq, reason: opts.reason });
    return rec;
  }

  /** Null when the task has no Git baseline yet (nothing it could have changed). */
  async create(task: TaskRecord, opts: { label: string; reason: CheckpointReason; stageKey?: string | null }): Promise<CheckpointRecord | null> {
    const units = this.workspaceUnits(task);
    if (units) return this.createAcross(task, units, opts);
    const cwd = await this.repoPath(task);
    if (!cwd) return null;
    const seq = this.chairman.nextCheckpointSeq(task.id);
    const ref = `refs/acc/checkpoints/${task.id}/${seq}`;
    const cp = await createCheckpoint(cwd, ref, `${task.id} checkpoint ${seq}: ${opts.label}`);
    const metadata = await checkpointMetadata(cwd).catch(() => ({}));
    const rec = this.chairman.insertCheckpoint({
      type: 'git',
      metadata,
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
   * Back up a SQLite database file of the task (V2 plan §16). The copy is
   * taken with SQLite's online backup, lives in the data folder, and is
   * restored only into the same file.
   */
  async createDatabase(task: TaskRecord, file: string, label: string, dataDir: string): Promise<CheckpointRecord | null> {
    const cwd = await this.databaseRoot(task);
    if (!cwd) return null;
    const absolute = path.resolve(cwd, file);
    if (!absolute.startsWith(path.resolve(cwd) + path.sep)) throw new EngineError('The database must be inside the task working directory', 'INVALID_INPUT');
    const seq = this.chairman.nextCheckpointSeq(task.id);
    const dir = path.join(dataDir, 'tasks', task.id, 'checkpoints');
    await mkdir(dir, { recursive: true });
    const backup = path.join(dir, `${seq}-${path.basename(absolute)}.bak`);
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(absolute, { readonly: true, fileMustExist: true });
    try {
      await db.backup(backup);
    } finally {
      db.close();
    }
    const rec = this.chairman.insertCheckpoint({
      id: newId(),
      taskId: task.id,
      seq,
      label: redact(label).slice(0, 120),
      reason: 'user',
      commit: '',
      ref: backup,
      head: null,
      stageKey: task.currentStageKey,
      createdAt: now(),
      type: 'database',
      metadata: { file: path.relative(cwd, absolute).split(path.sep).join('/'), backup },
    });
    this.bus.publish({ type: 'checkpoint', checkpoint: rec });
    this.publisher.event(task.id, 'CHECKPOINT_CREATED', `Database checkpoint ${seq}: ${rec.label}`, { checkpointId: rec.id, seq, type: 'database' });
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
    return this.asWriter(task, () => this.restoreLocked(task, checkpointId));
  }

  private async restoreLocked(task: TaskRecord, checkpointId?: string): Promise<{ checkpoint: CheckpointRecord; result: RestoreResult }> {
    const cwd = this.workspaceUnits(task) ? await this.databaseRoot(task) : await this.repoPath(task);
    if (!cwd) throw new EngineError('Rollback needs a Git repository and a recorded baseline; this task has neither.', 'INVALID_STATE');
    const target = checkpointId ? this.chairman.checkpoint(checkpointId) : this.lastChangeTarget(task);
    if (!target || target.taskId !== task.id) throw new EngineError(checkpointId ? 'Checkpoint not found' : 'There is no checkpoint before the last change to roll back to.', checkpointId ? 'NOT_FOUND' : 'INVALID_STATE');
    if (target.type === 'database') {
      const file = String(target.metadata?.file ?? '');
      const destination = path.resolve(cwd, file);
      if (!file || !destination.startsWith(path.resolve(cwd) + path.sep)) throw new EngineError('This database checkpoint does not name a file in the task', 'INVALID_STATE');
      await copyFile(destination, `${target.ref}.before-restore`).catch(() => undefined);
      await copyFile(target.ref, destination);
      this.publisher.event(task.id, 'ROLLBACK_COMPLETED', `Restored ${file} from database checkpoint ${target.seq}`, { checkpointId: target.id, type: 'database' });
      return { checkpoint: target, result: { restored: [file], removed: [], skipped: [] } };
    }
    if (target.type === 'deployment') throw new EngineError('Deployment checkpoints record the live version; roll a deployment back with an approved deploy of that version.', 'INVALID_STATE');
    const units = this.workspaceUnits(task);
    if (units) return this.restoreAcross(task, units, target);
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

  /**
   * Restore every repository of a task to one checkpoint, all or nothing:
   * refused when any repository has new commits since; the current state of
   * all of them is checkpointed first; and if one repository fails part-way,
   * the ones already restored are put back from that checkpoint.
   */
  private async restoreAcross(task: TaskRecord, units: TaskRepository[], target: CheckpointRecord): Promise<{ checkpoint: CheckpointRecord; result: RestoreResult }> {
    const parts = target.parts ?? [];
    const pairs = parts.map((p) => ({ part: p, unit: units.find((u) => u.repo.id === p.repositoryId) }));
    const missing = pairs.find((p) => !p.unit);
    if (!parts.length || missing) throw new EngineError(`Checkpoint ${target.seq} does not cover every repository of this task, so it cannot be restored across them.`, 'INVALID_STATE');
    for (const { part, unit } of pairs) {
      if ((await headCommit(unit!.workdir)) !== part.head) {
        throw new EngineError(`Rollback refused: ${unit!.repo.name} has new commits since checkpoint ${target.seq}, and rolling back across a commit could lose work. Revert that commit instead.`, 'INVALID_STATE');
      }
    }
    const safety = await this.createAcross(task, units, { label: `Before rolling back to checkpoint ${target.seq}`, reason: 'before-rollback', stageKey: task.currentStageKey });
    const result: RestoreResult = { restored: [], removed: [], skipped: [] };
    const done: TaskRepository[] = [];
    for (const { part, unit } of pairs) {
      try {
        const r = await restoreCheckpoint(unit!.workdir, part.commit, () => true);
        const label = (p: string) => (unit!.folder ? `${unit!.folder}/${p}` : p);
        result.restored.push(...r.restored.map(label));
        result.removed.push(...r.removed.map(label));
        result.skipped.push(...r.skipped.map(label));
        done.push(unit!);
      } catch (error) {
        // restoreCheckpoint may have changed the failing repository before it failed: put it back as well.
        let unrestored: string | null = null;
        for (const u of [...done, unit!]) {
          const back = safety?.parts?.find((p) => p.repositoryId === u.repo.id);
          const ok = back ? await restoreCheckpoint(u.workdir, back.commit, () => true).then(() => true, () => false) : false;
          if (!ok) unrestored = u.repo.name;
        }
        const reason = redact((error as Error).message).slice(0, 200);
        throw new EngineError(
          unrestored
            ? `Rollback of ${unit!.repo.name} failed (${reason}), and ${unrestored} could not be put back automatically: restore checkpoint ${safety?.seq ?? '(none)'} to return to the state before the rollback.`
            : `Rollback of ${unit!.repo.name} failed (${reason}); every repository was put back as it was before the rollback.`,
          'INVALID_STATE',
        );
      }
    }
    this.publisher.event(
      task.id,
      'ROLLBACK_COMPLETED',
      `Rolled back ${units.length} repositories to checkpoint ${target.seq} (${target.label}): ${result.restored.length} restored, ${result.removed.length} removed`,
      { checkpointId: target.id, ...result },
    );
    for (const u of units) this.repositories.invalidate(u.repo.id);
    return { checkpoint: target, result };
  }

  /** Drop the hidden refs once the task is finished; the rows stay as history. */
  async prune(task: TaskRecord): Promise<void> {
    if (!this.chairman.listCheckpoints(task.id).some((c) => (c.type ?? 'git') === 'git')) return;
    for (const unit of taskRepositories(this.store, task)) {
      try {
        await deleteRefs(unit.repo.path, `refs/acc/checkpoints/${task.id}/`);
      } catch {
        /* repository moved or deleted: nothing to clean */
      }
    }
  }
}
