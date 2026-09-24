import { POLICY_MODES, type PolicyMode } from '@acc/shared';
import type { RepositoryRecord, Store, TaskGitRecord, TaskRecord } from '../store/store.js';
import { taskWorkdir } from './workdir.js';

/**
 * The repositories a task works in (docs/plans/MULTI_REPO_TASKS_PLAN.md).
 *
 * A task always has its primary repository (`tasks.repository_id`, Git state
 * in `tasks.git`). A multi-repository task also has linked repositories, each
 * with its own Git record; all of them are worktrees side by side in one task
 * workspace folder, which is where agents and tools work. For a
 * single-repository task every function here answers exactly what the code
 * answered before linked repositories existed.
 */
export interface TaskRepository {
  repo: RepositoryRecord;
  /** Its folder in the task workspace; null for a single-repository task. */
  folder: string | null;
  git: TaskGitRecord;
  primary: boolean;
  /** Where this repository's files are for the task: its worktree while one exists, else the repository. */
  workdir: string;
}

/** Where the task's agents, tools and terminals work: the workspace of a multi-repository task, else the repository's working directory. */
export function agentWorkdir(task: Pick<TaskRecord, 'git'>, repo: Pick<RepositoryRecord, 'path'>): string {
  return task.git.workspacePath ?? taskWorkdir(task, repo);
}

/** Every repository of the task, primary first, then linked ones in order. Unknown repositories are left out. */
export function taskRepositories(store: Store, task: TaskRecord): TaskRepository[] {
  const out: TaskRepository[] = [];
  const primary = store.getRepository(task.repositoryId);
  if (primary) out.push({ repo: primary, folder: task.git.folder ?? null, git: task.git, primary: true, workdir: taskWorkdir(task, primary) });
  for (const linked of store.listLinkedRepositories(task.id)) {
    const repo = store.getRepository(linked.repositoryId);
    if (repo) out.push({ repo, folder: linked.folder, git: linked.git, primary: false, workdir: linked.git.worktreePath ?? repo.path });
  }
  return out;
}

export function taskRepository(store: Store, task: TaskRecord, repositoryId: string): TaskRepository | null {
  return taskRepositories(store, task).find((r) => r.repo.id === repositoryId) ?? null;
}

/** The task works in more than one repository. */
export function isMultiRepository(store: Store, task: Pick<TaskRecord, 'id'>): boolean {
  return store.listLinkedRepositories(task.id).length > 0;
}

/** Ids of every repository the task works in, primary first. */
export function taskRepositoryIds(store: Store, task: TaskRecord): string[] {
  return [task.repositoryId, ...store.listLinkedRepositories(task.id).map((l) => l.repositoryId)];
}

/** Label a path or name with its repository folder, only when the task has more than one repository. */
export function inFolder(folder: string | null, value: string): string {
  return folder ? `${folder}/${value}` : value;
}

/**
 * Folder names for the repositories of a task workspace, in order: the
 * repository name as a slug (letters, digits, dashes; at most 30), made
 * unique with -2, -3…
 */
export function workspaceFolders(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '') || 'repository';
    // Windows reserves these names in every folder.
    const base = /^(con|prn|aux|nul|com\d|lpt\d)$/.test(slug) ? `${slug}-repo` : slug;
    let folder = base;
    for (let n = 2; used.has(folder); n++) folder = `${base}-${n}`;
    used.add(folder);
    return folder;
  });
}

/** The most restrictive execution policy of several (safe < autopilot < full). */
export function strictestPolicy(modes: PolicyMode[]): PolicyMode {
  return POLICY_MODES[Math.min(...modes.map((m) => POLICY_MODES.indexOf(m)))]!;
}
