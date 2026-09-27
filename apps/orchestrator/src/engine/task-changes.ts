import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { changesSince } from '@acc/git';
import { isUiPath, type ChangedFile, type StageConditionFacts } from '@acc/shared';
import type { Store, TaskRecord } from '../store/store.js';
import { inFolder, taskRepositories } from './task-repositories.js';

/**
 * The task's own changes, across its repositories, read the same way wherever
 * a decision depends on them: the completion gate, and a stage's `when`
 * condition (docs/plans/DESIGNER_ROUTING_PLAN.md §5). Pre-existing work is
 * never the task's.
 */
export interface TaskChange {
  repositoryId: string;
  /** The repository's folder in a multi-repository task; null for one repository. */
  folder: string | null;
  /** Repository-relative, `/`-separated: what file rules (UI, protected paths) are judged on. */
  path: string;
  /** `path` labelled with its folder when the task has several repositories: what people and directives see. */
  label: string;
  /** Where the file is for the task (its worktree, else the repository). */
  workdir: string;
}

export interface TaskChanges {
  files: TaskChange[];
  /** False when a repository of the task has no Git baseline, so its changes are not in `files`. */
  complete: boolean;
  /** Repositories whose changes were read (those with a baseline). */
  baselines: number;
}

/**
 * Null when any repository's changes cannot be read: the whole list is then
 * unknown, never a partial one.
 */
export async function taskChanges(store: Store, task: TaskRecord): Promise<TaskChanges | null> {
  const units = taskRepositories(store, task);
  const files: TaskChange[] = [];
  let complete = units.length > 0;
  let baselines = 0;
  for (const unit of units) {
    const baseline = unit.git.baselineSnapshotId ? store.getSnapshot(unit.git.baselineSnapshotId) : null;
    if (!baseline) {
      complete = false;
      continue;
    }
    baselines++;
    let changed: ChangedFile[];
    try {
      changed = await changesSince(unit.workdir, baseline);
    } catch {
      return null;
    }
    const folder = units.length > 1 ? unit.folder : null;
    for (const f of changed) {
      if (f.origin === 'preexisting') continue;
      files.push({ repositoryId: unit.repo.id, folder, path: f.path, label: inFolder(folder, f.path), workdir: unit.workdir });
    }
  }
  return { files, complete, baselines };
}

/** What a stage condition is judged on: unknown whenever the list is (no Git, no baseline, unreadable). */
export function conditionFacts(changes: TaskChanges | null): StageConditionFacts {
  if (!changes || !changes.complete) return { uiChanged: null };
  return { uiChanged: changes.files.some((f) => isUiPath(f.path)) };
}

/**
 * A fingerprint of the task's user-interface files as they are now (path and
 * content; a deleted file counts as deleted). Two equal digests mean the look
 * the visual critique judged has not changed. Null when unknown.
 */
export async function uiDigest(changes: TaskChanges | null): Promise<string | null> {
  if (!changes || !changes.complete) return null;
  const ui = changes.files.filter((f) => isUiPath(f.path)).sort((a, b) => a.label.localeCompare(b.label));
  const hash = createHash('sha256');
  for (const f of ui) {
    const content = await readFile(path.join(f.workdir, f.path)).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    hash.update(`${f.label}\0${content ? createHash('sha256').update(content).digest('hex') : 'deleted'}\n`);
  }
  return hash.digest('hex');
}
