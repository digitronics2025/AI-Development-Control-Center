import type { RepositoryCommand } from '@acc/shared';
import { detectToolingSync, mergeDetected, pathKey, type Detected } from '../services/repositories.js';
import type { RepositoryRecord, Store } from '../store/store.js';

/** The toolchain detection proposes a command for (`detectToolingSync`'s ids). */
function toolOf(commandId: string): string {
  if (commandId.startsWith('gradle-')) return 'gradle';
  if (commandId.startsWith('cargo-')) return 'rust';
  if (commandId.startsWith('go-')) return 'go';
  return 'node';
}

/**
 * The repository's own folder has this check and its stored settings were
 * detected with that toolchain present: leaving it out was the operator's
 * choice (removed, replaced). When the stored settings predate the toolchain
 * — registered empty, before any package.json — they are only out of date.
 */
function leftOutOnPurpose(repo: RepositoryRecord, own: Detected, commandId: string): boolean {
  return own.commands.some((c) => c.id === commandId) && repo.tooling.includes(toolOf(commandId));
}

/**
 * A repository as one task sees it: its stored settings, plus the checks and
 * app start command detected in the task's files (`workdir`, the task's
 * worktree) that the stored settings do not have. A new app gets its first
 * `test`, `build` and `dev` scripts from the task that builds it; those
 * scripts are that task's gates without anyone pressing Re-detect, and so are
 * they for the next task, until someone does.
 *
 * Stored commands win by id (one the operator disabled stays disabled), and a
 * check the operator left out on purpose stays out (`leftOutOnPurpose`).
 * Never written back: the stored record describes the operator's checkout, not
 * the task's branch. The command lines are detection's fixed templates, never
 * text from the files.
 */
export function taskRepositoryView(repo: RepositoryRecord, workdir: string): RepositoryRecord {
  const detected = detectToolingSync(workdir);
  const own = pathKey(workdir) === pathKey(repo.path) ? detected : detectToolingSync(repo.path);
  const { commands, added } = mergeDetected(repo, { ...detected, commands: detected.commands.filter((c) => !leftOutOnPurpose(repo, own, c.id)) });
  // A found start command fills in only when none is stored and none was left out on purpose; the rest of the
  // stored runtime (checked pages, mode) is kept.
  const devOnPurpose = Boolean(own.runtime.devCommand) && repo.tooling.includes('node');
  const fillsDev = !repo.runtime.devCommand && !devOnPurpose && Boolean(detected.runtime.devCommand);
  if (!added.length && !fillsDev) return repo;
  const runtime = fillsDev ? { ...repo.runtime, devCommand: detected.runtime.devCommand, devUrl: detected.runtime.devUrl, verifyMode: detected.runtime.verifyMode } : repo.runtime;
  return { ...repo, commands, runtime, tooling: [...new Set([...repo.tooling, ...detected.tooling])] };
}

/**
 * Where a check a task runs comes from: the repository's stored settings, the
 * repository's own files (stored settings out of date — its base commit has
 * it), or only the task's own files (its base commit has no result for it).
 */
export function checkOrigin(store: Store, repo: Pick<RepositoryRecord, 'id'>, command: Pick<RepositoryCommand, 'id'>): 'stored' | 'repository' | 'task' {
  const stored = store.getRepository(repo.id);
  if (!stored || stored.commands.some((c) => c.id === command.id)) return 'stored';
  return detectToolingSync(stored.path).commands.some((c) => c.id === command.id) ? 'repository' : 'task';
}

/** The check exists only in the task's own files, so its base commit has nothing to compare with. */
export function addedByTask(store: Store, repo: Pick<RepositoryRecord, 'id'>, command: Pick<RepositoryCommand, 'id'>): boolean {
  return checkOrigin(store, repo, command) === 'task';
}

/** The app start command came from detection (the task's or the repository's files), not the stored settings. */
export function devCommandDetected(store: Store, repo: RepositoryRecord): boolean {
  const stored = store.getRepository(repo.id);
  return Boolean(stored && !stored.runtime.devCommand && repo.runtime.devCommand);
}
