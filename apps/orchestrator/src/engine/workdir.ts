import type { RepositoryRecord, TaskRecord } from '../store/store.js';

/**
 * Where a task's files are: its isolated worktree while one exists
 * (Git mode `worktree`), otherwise the repository itself.
 */
export function taskWorkdir(task: Pick<TaskRecord, 'git'>, repo: Pick<RepositoryRecord, 'path'>): string {
  return task.git.worktreePath ?? repo.path;
}
