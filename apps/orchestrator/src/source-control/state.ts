import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  absoluteGitDir,
  indexLocked,
  listRemotes,
  operationInProgress,
  repositoryStatus,
  type PorcelainBranch,
  type PorcelainEntry,
} from '@acc/git';
import type { GitOperationInProgress } from '@acc/shared';

/**
 * Git state of one repository as Source Control sees it, plus the
 * fingerprint (`version`) that every mutation is checked against.
 */
export interface EntryState {
  path: string;
  originalPath: string | null;
  kind: PorcelainEntry['kind'];
  xy: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  /** Git's record for the entry (index side, modes, object ids). */
  raw: string;
  /** `raw` plus the worktree file's size and mtime, so re-edits of an already modified file change it. */
  fingerprint: string;
}

export interface RepoState {
  root: string;
  gitDir: string;
  version: string;
  branch: PorcelainBranch;
  hasHead: boolean;
  entries: EntryState[];
  byPath: Map<string, EntryState>;
  operation: GitOperationInProgress | null;
  indexLocked: boolean;
  remotes: string[];
  /** Status output exceeded its bound; the entry list is incomplete. */
  truncated: boolean;
}

/** Worktree stat calls per snapshot; beyond this the fingerprint relies on Git's record alone. */
const MAX_STATS = 10_000;

async function worktreeStamp(root: string, file: string): Promise<string> {
  try {
    const info = await lstat(path.join(root, file));
    return `${info.size}:${Math.trunc(info.mtimeMs)}`;
  } catch {
    return 'absent';
  }
}

export async function readRepoState(root: string, gitDir?: string): Promise<RepoState> {
  const [status, resolvedGitDir, remotes] = await Promise.all([repositoryStatus(root), gitDir ? Promise.resolve(gitDir) : absoluteGitDir(root), listRemotes(root)]);
  const hasWorktreeSide = (e: PorcelainEntry) => e.kind === '?' || e.kind === 'u' || e.xy[1] !== '.';
  const targets = status.entries.filter(hasWorktreeSide).slice(0, MAX_STATS).map((e) => e.path);
  const stamps = new Map<string, string>();
  for (let i = 0; i < targets.length; i += 256) {
    await Promise.all(targets.slice(i, i + 256).map(async (p) => stamps.set(p, await worktreeStamp(root, p))));
  }
  const entries: EntryState[] = status.entries.map((e) => {
    const tracked = e.kind === '1' || e.kind === '2';
    return {
      path: e.path,
      originalPath: e.origPath,
      kind: e.kind,
      xy: e.xy,
      staged: tracked && e.xy[0] !== '.',
      unstaged: tracked && e.xy[1] !== '.',
      untracked: e.kind === '?',
      conflicted: e.kind === 'u',
      raw: e.raw,
      fingerprint: `${e.raw}\x1f${stamps.get(e.path) ?? ''}`,
    };
  });
  const operation = operationInProgress(resolvedGitDir);
  const locked = indexLocked(resolvedGitDir);
  const hash = createHash('sha256');
  const b = status.branch;
  hash.update(`${b.oid}|${b.head}|${b.detached}|${b.upstream}|${b.ahead}|${b.behind}|${operation}|${status.truncated}\n`);
  for (const e of entries) hash.update(`${e.fingerprint}\n`);
  return {
    root,
    gitDir: resolvedGitDir,
    version: hash.digest('base64url').slice(0, 32),
    branch: b,
    hasHead: b.oid !== null,
    entries,
    byPath: new Map(entries.map((e) => [e.path, e])),
    operation,
    indexLocked: locked,
    remotes,
    truncated: status.truncated,
  };
}

// ---------------------------------------------------------------------------
// Relevant-scope staleness
//
// A mutation carries the version the user looked at. When the repository has
// changed since, the request is still safe if nothing *it depends on*
// changed — an unrelated file edited in the editor must not reject "stage
// a.ts". Each scope below is the state one kind of action depends on.
// ---------------------------------------------------------------------------

function head(s: RepoState): string {
  return `${s.branch.oid}|${s.branch.head}|${s.branch.detached}|${s.operation}`;
}

export const scopes = {
  /** Staging or unstaging these paths depends on exactly these entries. */
  paths: (paths: string[]) => (s: RepoState) => [head(s), ...[...paths].sort().map((p) => `${p}=${s.byPath.get(p)?.fingerprint ?? 'absent'}`)].join('\n'),
  /** Stage All depends on every entry with a worktree side. */
  worktree: (s: RepoState) => [head(s), ...s.entries.filter((e) => e.unstaged || e.untracked || e.conflicted).map((e) => e.fingerprint)].join('\n'),
  /** Unstage All and Commit depend on the index (what is staged) and HEAD. */
  index: (s: RepoState) => [head(s), ...s.entries.filter((e) => e.staged || e.conflicted).map((e) => e.raw)].join('\n'),
  /** Fetch, sync and publish depend on the branch, its upstream and whether tracked files are clean. */
  branch: (s: RepoState) =>
    [head(s), s.branch.upstream, s.branch.ahead, s.branch.behind, s.entries.some((e) => e.staged || e.unstaged || e.conflicted)].join('|'),
};
