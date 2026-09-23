import type { GitFileStatus, RepositoryChangedPath, SourceControlSnapshot } from '@acc/shared';

/** Status letter shown in a row, with its name for screen readers (never the letter alone). */
export const STATUS_LETTER: Record<GitFileStatus, string> = {
  unmodified: ' ',
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  'type-changed': 'T',
  untracked: 'U',
  unmerged: '!',
};

export const STATUS_NAME: Record<GitFileStatus, string> = {
  unmodified: 'unmodified',
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  'type-changed': 'type changed',
  untracked: 'untracked',
  unmerged: 'conflicted',
};

export const ATTRIBUTION_LABEL: Record<NonNullable<RepositoryChangedPath['attribution']>, string> = {
  task: 'Task change',
  preexisting: 'Your change',
  both: 'Mixed: yours + task',
};

export const OPERATION_LABEL: Record<string, string> = {
  stage: 'Stage',
  unstage: 'Unstage',
  commit: 'Commit',
  fetch: 'Fetch',
  fast_forward: 'Fast-forward',
  push: 'Push',
  publish: 'Publish',
  sync: 'Sync',
};

export function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf('/');
  return index === -1 ? { dir: '', name: path } : { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}

/** What Sync is expected to do, from the last known state; the orchestrator decides again after fetching. */
export function syncPlan(s: SourceControlSnapshot): string[] {
  const b = s.branch;
  const remote = b.upstream?.split('/')[0] ?? 'the remote';
  const steps = [`Fetch ${remote}`];
  const tracked = s.changes.some((c) => c.staged || c.unstaged);
  if ((b.ahead ?? 0) > 0 && (b.behind ?? 0) > 0) steps.push(`Stop: ${b.name} and ${b.upstream} have diverged. Sync never merges or rebases.`);
  else if ((b.ahead ?? 0) > 0) steps.push(`Then push ${b.ahead} local commit${b.ahead === 1 ? '' : 's'} to ${b.upstream}`);
  else if ((b.behind ?? 0) > 0)
    steps.push(tracked ? `Then stop: ${b.behind} new commit${b.behind === 1 ? '' : 's'} wait until your uncommitted changes are committed` : `Then fast-forward ${b.name} by ${b.behind} commit${b.behind === 1 ? '' : 's'}`);
  else steps.push('Then push or fast-forward only if the fetch finds something new');
  return steps;
}
