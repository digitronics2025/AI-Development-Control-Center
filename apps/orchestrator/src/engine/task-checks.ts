import type { RepositoryCommand } from '@acc/shared';
import { detectToolingSync, mergeDetected, pathKey } from '../services/repositories.js';
import type { RepositoryRecord, Store } from '../store/store.js';

/**
 * A repository as one task sees it: its stored settings, plus the checks and
 * app start command found in the task's own files (`workdir`, the task's
 * worktree). A new app gets its first `test`, `build` and `dev` scripts from
 * the task that builds it; those scripts are that task's gates without
 * anyone pressing Re-detect.
 *
 * Only what the task added counts: a check detected in the task's worktree
 * but not in the repository's own folder. A script the repository already
 * has is the operator's to configure — one they removed, replaced or disabled
 * stays that way — and stored commands win by id. A task working in the
 * operator's own folder (no worktree) adds nothing. Never written back: the
 * stored record describes the operator's checkout, not the task's branch. The
 * command lines are detection's fixed templates, never text from the files.
 */
export function taskRepositoryView(repo: RepositoryRecord, workdir: string): RepositoryRecord {
  if (pathKey(workdir) === pathKey(repo.path)) return repo;
  const detected = detectToolingSync(workdir);
  const own = detectToolingSync(repo.path);
  const ownIds = new Set(own.commands.map((c) => c.id));
  const { commands, added } = mergeDetected(repo, { ...detected, commands: detected.commands.filter((c) => !ownIds.has(c.id)) });
  // Only a start command the task added fills in; the rest of the stored runtime (checked pages, mode) is kept.
  const fillsDev = !repo.runtime.devCommand && !own.runtime.devCommand && Boolean(detected.runtime.devCommand);
  if (!added.length && !fillsDev) return repo;
  const runtime = fillsDev ? { ...repo.runtime, devCommand: detected.runtime.devCommand, devUrl: detected.runtime.devUrl, verifyMode: detected.runtime.verifyMode } : repo.runtime;
  return { ...repo, commands, runtime, tooling: [...new Set([...repo.tooling, ...detected.tooling])] };
}

/** The check exists only in the task's own files: not in the repository's stored commands, so its base commit has no result for it. */
export function addedByTask(store: Store, repo: Pick<RepositoryRecord, 'id'>, command: Pick<RepositoryCommand, 'id'>): boolean {
  const stored = store.getRepository(repo.id);
  return Boolean(stored) && !stored!.commands.some((c) => c.id === command.id);
}

/** The app start command came from the task's own files, not the repository's stored settings. */
export function devCommandAddedByTask(store: Store, repo: RepositoryRecord): boolean {
  const stored = store.getRepository(repo.id);
  return Boolean(stored && !stored.runtime.devCommand && repo.runtime.devCommand);
}
