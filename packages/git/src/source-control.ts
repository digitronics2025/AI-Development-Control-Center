import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CommitFileChange, CommitRef, GitFileStatus, GitOperationInProgress } from '@acc/shared';
import { EMPTY_TREE, git, parseNumstat, type GitResult } from './index.js';

/*
 * Repository-level Source Control primitives. Every function runs native Git
 * with an argv array (never a shell); paths travel on stdin as NUL-separated
 * literal pathspecs, so no file name is ever read as an option or a glob.
 * Nothing here knows about tasks, locks or policy — that is the
 * orchestrator's job.
 */

/** Options that stop Git from running user-configured external diff or textconv programs. */
const DIFF_SAFETY = ['--no-color', '--no-ext-diff', '--no-textconv'];
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

// ---------------------------------------------------------------------------
// Status (porcelain v2)
// ---------------------------------------------------------------------------

export interface PorcelainEntry {
  /** `1` ordinary, `2` rename/copy, `u` unmerged, `?` untracked. */
  kind: '1' | '2' | 'u' | '?';
  /** Two status letters: index then worktree, `.` for unmodified. */
  xy: string;
  path: string;
  origPath: string | null;
  /** The record exactly as Git printed it; part of the state fingerprint. */
  raw: string;
}

export interface PorcelainBranch {
  oid: string | null;
  head: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface PorcelainStatus {
  branch: PorcelainBranch;
  entries: PorcelainEntry[];
}

/** Parse `git status --porcelain=v2 -z --branch` output. */
export function parsePorcelainV2(raw: string): PorcelainStatus {
  const branch: PorcelainBranch = { oid: null, head: null, detached: false, upstream: null, ahead: null, behind: null };
  const entries: PorcelainEntry[] = [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record) continue;
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') branch.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') {
        branch.detached = value === '(detached)';
        branch.head = branch.detached ? null : value;
      } else if (key === 'branch.upstream') branch.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          branch.ahead = Number(m[1]);
          branch.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = record[0];
    if (kind === '?') {
      entries.push({ kind: '?', xy: '??', path: record.slice(2), origPath: null, raw: record });
    } else if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path
      const fields = splitFields(record, 8);
      entries.push({ kind: '1', xy: fields[1]!, path: fields[8]!, origPath: null, raw: record });
    } else if (kind === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const fields = splitFields(record, 9);
      const origPath = parts[++i] ?? null;
      entries.push({ kind: '2', xy: fields[1]!, path: fields[9]!, origPath, raw: `${record}\0${origPath ?? ''}` });
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const fields = splitFields(record, 10);
      entries.push({ kind: 'u', xy: fields[1]!, path: fields[10]!, origPath: null, raw: record });
    }
  }
  return { branch, entries };
}

/** Split on the first `count` spaces; the remainder (a path, which may contain spaces) is the last field. */
function splitFields(record: string, count: number): string[] {
  const fields: string[] = [];
  let rest = record;
  for (let n = 0; n < count; n++) {
    const index = rest.indexOf(' ');
    if (index === -1) break;
    fields.push(rest.slice(0, index));
    rest = rest.slice(index + 1);
  }
  fields.push(rest);
  return fields;
}

export function statusFromLetter(letter: string | undefined): GitFileStatus {
  switch (letter) {
    case 'M':
      return 'modified';
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type-changed';
    case 'U':
      return 'unmerged';
    case '?':
      return 'untracked';
    default:
      return 'unmodified';
  }
}

export async function repositoryStatus(cwd: string, options: { maxOutputBytes?: number } = {}): Promise<PorcelainStatus & { raw: string; truncated: boolean }> {
  const result = await git(cwd, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], {
    maxOutputBytes: options.maxOutputBytes ?? 64 * 1024 * 1024,
    timeoutMs: 60_000,
  });
  if (result.code !== 0 && !result.truncated) throw gitFailure('status', result);
  return { ...parsePorcelainV2(result.stdout), raw: result.stdout, truncated: Boolean(result.truncated) };
}

export async function absoluteGitDir(cwd: string): Promise<string> {
  const result = await git(cwd, ['rev-parse', '--absolute-git-dir']);
  if (result.code !== 0) throw gitFailure('rev-parse', result);
  return result.stdout.trim();
}

/** A merge, rebase, cherry-pick, revert or bisect left in progress, from the marker files Git writes. */
export function operationInProgress(gitDir: string): GitOperationInProgress | null {
  const has = (name: string) => existsSync(path.join(gitDir, name));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  if (has('BISECT_LOG')) return 'bisect';
  return null;
}

export function indexLocked(gitDir: string): boolean {
  return existsSync(path.join(gitDir, 'index.lock'));
}

export async function listRemotes(cwd: string): Promise<string[]> {
  const result = await git(cwd, ['remote']);
  return result.code === 0 ? result.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

async function configValue(cwd: string, key: string): Promise<string | null> {
  const result = await git(cwd, ['config', '--get', key]);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

/** The remote and remote ref a branch pushes to and pulls from, from its configuration. */
export async function branchUpstream(cwd: string, branch: string): Promise<{ remote: string; mergeRef: string } | null> {
  const [remote, mergeRef] = await Promise.all([configValue(cwd, `branch.${branch}.remote`), configValue(cwd, `branch.${branch}.merge`)]);
  if (!remote || !mergeRef || remote === '.') return null;
  return { remote, mergeRef };
}

export async function revParse(cwd: string, ref: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return result.code === 0;
}

export async function aheadBehind(cwd: string, local: string, upstream: string): Promise<{ ahead: number; behind: number } | null> {
  const result = await git(cwd, ['rev-list', '--left-right', '--count', `${local}...${upstream}`]);
  if (result.code !== 0) return null;
  const [ahead, behind] = result.stdout.trim().split(/\s+/).map(Number);
  return ahead === undefined || behind === undefined ? null : { ahead, behind };
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export type LineStats = Map<string, { additions: number | null; deletions: number | null }>;

/** Additions/deletions per path for the index (`staged`) or the worktree (`unstaged`) side. */
export async function lineStats(cwd: string, side: 'staged' | 'unstaged', options: { hasHead: boolean }): Promise<LineStats> {
  const args = side === 'staged' ? ['diff', '--cached', ...(options.hasHead ? [] : [EMPTY_TREE])] : ['diff'];
  const result = await git(cwd, [...args, ...DIFF_SAFETY, '--numstat', '-z', '-M'], { maxOutputBytes: 8 * 1024 * 1024, timeoutMs: 30_000 });
  if (result.code !== 0 || result.truncated) return new Map();
  return parseNumstat(result.stdout);
}

export interface PathDiff {
  diff: string;
  truncated: boolean;
  binary: boolean;
}

/**
 * The diff of one path: `staged` is index against HEAD, `unstaged` is
 * worktree against index. An untracked file is shown as a new file.
 */
export async function pathDiff(
  cwd: string,
  options: { path: string; originalPath?: string | null; mode: 'staged' | 'unstaged'; untracked: boolean; hasHead: boolean; maxBytes: number },
): Promise<PathDiff> {
  const pathspec = ['--', ...(options.originalPath ? [options.originalPath] : []), options.path];
  let base: string[];
  if (options.untracked) base = ['diff', '--no-index', ...DIFF_SAFETY];
  else if (options.mode === 'staged') base = ['diff', '--cached', ...(options.hasHead ? [] : [EMPTY_TREE]), ...DIFF_SAFETY, '-M'];
  else base = ['diff', ...DIFF_SAFETY];
  const target = options.untracked ? ['--', NULL_DEVICE, options.path] : pathspec;

  const stat = await git(cwd, [...base, '--numstat', ...target], { maxOutputBytes: 64 * 1024 });
  if (/^-\t-\t/m.test(stat.stdout)) return { diff: '', truncated: false, binary: true };
  const result = await git(cwd, [...base, ...target], { maxOutputBytes: options.maxBytes, timeoutMs: 30_000 });
  // `--no-index` exits 1 when the files differ, which is the expected case.
  const ok = result.code === 0 || (options.untracked && result.code === 1) || result.truncated;
  if (!ok) throw gitFailure('diff', result);
  return { diff: result.stdout, truncated: Boolean(result.truncated), binary: /^Binary files .* differ$/m.test(result.stdout) };
}

/** Staged changes with no context lines, for the secret preflight. */
export async function stagedPatch(cwd: string, options: { hasHead: boolean; maxBytes: number }): Promise<{ patch: string; truncated: boolean }> {
  const result = await git(cwd, ['diff', '--cached', ...(options.hasHead ? [] : [EMPTY_TREE]), ...DIFF_SAFETY, '-U0', '--no-renames'], {
    maxOutputBytes: options.maxBytes,
    timeoutMs: 60_000,
  });
  if (result.code !== 0 && !result.truncated) throw gitFailure('diff', result);
  return { patch: result.stdout, truncated: Boolean(result.truncated) };
}

/** Patches of every commit reachable from `tip` but not from `exclude` (or from no remote), for the push preflight. */
export async function outgoingPatch(cwd: string, options: { tip: string; exclude: string | null; maxBytes: number }): Promise<{ patch: string; truncated: boolean; commits: number }> {
  const range = options.exclude ? [options.tip, '--not', options.exclude] : [options.tip, '--not', '--remotes'];
  const result = await git(cwd, ['log', '-p', '-U0', '--no-renames', ...DIFF_SAFETY, '--format=%x00commit %H', ...range, '--'], {
    maxOutputBytes: options.maxBytes,
    timeoutMs: 60_000,
  });
  if (result.code !== 0 && !result.truncated) throw gitFailure('log', result);
  const commits = (result.stdout.match(/\0commit [0-9a-f]+/g) ?? []).length;
  return { patch: result.stdout, truncated: Boolean(result.truncated), commits };
}

/** Files named in `diff --git` headers of a patch, and its added lines. */
export function splitPatch(patch: string): { files: string[]; added: string } {
  const files = new Set<string>();
  const added: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m) files.add(m[2]!);
    } else if (line.startsWith('+') && !line.startsWith('+++')) added.push(line.slice(1));
  }
  return { files: [...files], added: added.join('\n') };
}

// ---------------------------------------------------------------------------
// Index mutations
// ---------------------------------------------------------------------------

function pathspecInput(paths: string[]): string {
  return paths.join('\0') + '\0';
}

/** Stage exactly these paths (additions, modifications and deletions). */
export async function stagePaths(cwd: string, paths: string[]): Promise<GitResult> {
  return git(cwd, ['--literal-pathspecs', 'add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], { stdin: pathspecInput(paths), timeoutMs: 120_000 });
}

/**
 * Remove these paths from the index without touching the worktree. With no
 * commits yet there is no HEAD to restore from, so the entries are dropped
 * from the index instead — which is exactly "unstaged" on an unborn branch.
 */
export async function unstagePaths(cwd: string, paths: string[], options: { hasHead: boolean }): Promise<GitResult> {
  const args = options.hasHead
    ? ['--literal-pathspecs', 'restore', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul']
    : ['--literal-pathspecs', 'rm', '--cached', '--quiet', '-r', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'];
  return git(cwd, args, { stdin: pathspecInput(paths), timeoutMs: 120_000 });
}

/** Commit the index. Hooks run as usual; the message travels on stdin. */
export async function commitStaged(cwd: string, message: string): Promise<GitResult> {
  return git(cwd, ['commit', '--file=-', '--cleanup=strip'], { stdin: message, timeoutMs: 10 * 60_000 });
}

/** Whether any of the named hooks is installed (respects core.hooksPath). */
export async function hooksInstalled(cwd: string, names: string[]): Promise<boolean> {
  const result = await git(cwd, ['rev-parse', '--git-path', 'hooks']);
  if (result.code !== 0) return false;
  const dir = path.resolve(cwd, result.stdout.trim());
  return names.some((name) => existsSync(path.join(dir, name)));
}

// ---------------------------------------------------------------------------
// Remote operations
// ---------------------------------------------------------------------------

const REMOTE_TIMEOUT_MS = 120_000;

/**
 * Environment for remote calls nobody is watching: a credential prompt (Git
 * Credential Manager's sign-in window, an SSH passphrase dialog) must fail the
 * call instead of appearing on screen. The terminal prompt is already off.
 */
export const UNATTENDED_REMOTE_ENV: NodeJS.ProcessEnv = {
  GCM_INTERACTIVE: 'never',
  SSH_ASKPASS_REQUIRE: 'never',
};

export async function fetchRemote(cwd: string, remote: string, options: { unattended?: boolean } = {}): Promise<GitResult> {
  return git(cwd, ['fetch', '--no-write-fetch-head', remote], { timeoutMs: REMOTE_TIMEOUT_MS, ...(options.unattended ? { env: UNATTENDED_REMOTE_ENV } : {}) });
}

/** Move the current branch to `ref` only if that is a fast-forward. Never merges. */
export async function fastForward(cwd: string, ref: string): Promise<GitResult> {
  return git(cwd, ['merge', '--ff-only', '--no-edit', ref], { timeoutMs: 120_000 });
}

export interface PushLine {
  flag: string;
  from: string;
  to: string;
  summary: string;
}

/** Push `refs/heads/<local>` to `<remoteRef>` without any force option. */
export async function pushRef(cwd: string, options: { remote: string; localBranch: string; remoteRef: string; setUpstream: boolean }): Promise<GitResult & { lines: PushLine[] }> {
  const args = ['push', '--porcelain', ...(options.setUpstream ? ['--set-upstream'] : []), options.remote, `refs/heads/${options.localBranch}:${options.remoteRef}`];
  const result = await git(cwd, args, { timeoutMs: REMOTE_TIMEOUT_MS });
  return { ...result, lines: parsePushPorcelain(result.stdout) };
}

export function parsePushPorcelain(stdout: string): PushLine[] {
  const lines: PushLine[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^([ +\-*!=])\t([^\t]*)\t(.*)$/.exec(line);
    if (!m) continue;
    const [from = '', to = ''] = m[2]!.split(':');
    lines.push({ flag: m[1]!, from, to, summary: m[3]! });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface LogRecord {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committedAt: string;
  refs: CommitRef[];
  subject: string;
}

const LOG_FORMAT = '%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%D%x1f%s';
const RECORD_SEPARATOR = String.fromCharCode(0x1e);
const MAX_REFS = 20;

export function parseRefs(decoration: string): CommitRef[] {
  const refs: CommitRef[] = [];
  for (const raw of decoration.split(', ').map((r) => r.trim()).filter(Boolean)) {
    if (raw === 'HEAD') refs.push({ name: 'HEAD', kind: 'head' });
    else if (raw.startsWith('HEAD -> ')) {
      refs.push({ name: 'HEAD', kind: 'head' });
      refs.push({ name: raw.slice('HEAD -> '.length), kind: 'branch' });
    } else if (raw.startsWith('tag: ')) refs.push({ name: raw.slice(5), kind: 'tag' });
    else if (raw.includes('/') && !raw.startsWith('refs/heads/')) refs.push({ name: raw, kind: raw.endsWith('/HEAD') ? 'remote' : 'remote' });
    else refs.push({ name: raw, kind: 'branch' });
    if (refs.length >= MAX_REFS) break;
  }
  return refs;
}

export function parseLog(stdout: string): LogRecord[] {
  return stdout
    .split('\x1e')
    .map((r) => r.replace(/^\n+|\n+$/g, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha = '', parents = '', authorName = '', authorEmail = '', authoredAt = '', committedAt = '', refs = '', subject = ''] = record.split('\x1f');
      return {
        sha,
        parents: parents.split(' ').filter(Boolean).slice(0, 16),
        authorName,
        authorEmail,
        authoredAt,
        committedAt,
        refs: parseRefs(refs),
        subject,
      };
    });
}

/**
 * One page of history reachable from `tips`, in topological order so a
 * commit never appears above one of its children (the graph relies on it).
 * Local branch names win over same-named files through the trailing `--`.
 */
export async function historyPage(cwd: string, options: { tips: string[]; skip: number; limit: number }): Promise<LogRecord[]> {
  if (options.tips.length === 0) return [];
  const result = await git(
    cwd,
    ['log', '--topo-order', '--no-color', `--format=${LOG_FORMAT}`, `--skip=${options.skip}`, `-n`, String(options.limit), '--decorate=short', ...options.tips, '--'],
    { maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 60_000 },
  );
  if (result.code !== 0 && !result.truncated) throw gitFailure('log', result);
  return parseLog(result.stdout);
}

export interface CommitMeta extends LogRecord {
  body: string;
  committerName: string;
  committerEmail: string;
}

export async function commitMeta(cwd: string, sha: string): Promise<CommitMeta | null> {
  const result = await git(cwd, ['log', '-1', '--no-color', '--decorate=short', `--format=${LOG_FORMAT}%x1f%cn%x1f%ce%x1f%B`, sha, '--'], {
    maxOutputBytes: 1024 * 1024,
  });
  if (result.code !== 0) return null;
  // Everything after the leading separator: the body itself may contain any character.
  const record = result.stdout.slice(result.stdout.indexOf(RECORD_SEPARATOR) + 1);
  const fields = record.split('\x1f');
  const [base] = parseLog(`\x1e${fields.slice(0, 8).join('\x1f')}`);
  if (!base) return null;
  return { ...base, committerName: fields[8] ?? '', committerEmail: fields[9] ?? '', body: (fields.slice(10).join('\x1f') ?? '').trim() };
}

/** Files changed by a commit against its first parent (or the empty tree for a root commit). */
export async function commitFiles(cwd: string, sha: string, limit: number): Promise<{ files: CommitFileChange[]; truncated: boolean }> {
  const base = ['diff-tree', '-r', '-M', '--root', '--no-commit-id', '-m', '--first-parent', ...DIFF_SAFETY];
  const [status, stats] = await Promise.all([
    git(cwd, [...base, '--name-status', '-z', sha], { maxOutputBytes: 8 * 1024 * 1024 }),
    git(cwd, [...base, '--numstat', '-z', sha], { maxOutputBytes: 8 * 1024 * 1024 }),
  ]);
  if (status.code !== 0 && !status.truncated) throw gitFailure('diff-tree', status);
  const numstat = parseNumstat(stats.stdout);
  const parts = status.stdout.split('\0');
  const files: CommitFileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const letter = code[0];
    let originalPath: string | null = null;
    if (letter === 'R' || letter === 'C') originalPath = parts[++i] ?? null;
    const file = parts[++i];
    if (!file) continue;
    const stat = numstat.get(file);
    files.push({ path: file, originalPath, status: statusFromLetter(letter), additions: stat?.additions ?? null, deletions: stat?.deletions ?? null });
  }
  return { files: files.slice(0, limit), truncated: files.length > limit || Boolean(status.truncated) };
}

export async function commitFileDiff(cwd: string, options: { sha: string; path: string; originalPath: string | null; maxBytes: number }): Promise<PathDiff> {
  const args = ['diff-tree', '-p', '-M', '--root', '--no-commit-id', '-m', '--first-parent', ...DIFF_SAFETY, options.sha, '--', ...(options.originalPath ? [options.originalPath] : []), options.path];
  const result = await git(cwd, args, { maxOutputBytes: options.maxBytes, timeoutMs: 30_000 });
  if (result.code !== 0 && !result.truncated) throw gitFailure('diff-tree', result);
  return { diff: result.stdout, truncated: Boolean(result.truncated), binary: /^Binary files .* differ$/m.test(result.stdout) };
}

export interface CommitSummary {
  sha: string;
  parents: string[];
  message: string;
}

/** Commits reachable from `to` but not `from` (all of them when `from` is null), newest first. */
export async function commitsSince(cwd: string, from: string | null, to: string, limit: number): Promise<CommitSummary[]> {
  const range = from ? [`${from}..${to}`] : [to];
  const result = await git(cwd, ['log', `-n`, String(limit), '--format=%x1e%H%x1f%P%x1f%B', ...range, '--'], { maxOutputBytes: 4 * 1024 * 1024 });
  if (result.code !== 0) return [];
  return result.stdout
    .split('\x1e')
    .filter((r) => r.trim())
    .map((record) => {
      const [sha = '', parents = '', ...message] = record.split('\x1f');
      return { sha: sha.trim(), parents: parents.split(' ').filter(Boolean), message: message.join('\x1f').trim() };
    });
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type GitFailureCode =
  | 'INDEX_LOCKED'
  | 'NOTHING_STAGED'
  | 'IDENTITY_MISSING'
  | 'SIGNING_FAILED'
  | 'REMOTE_AUTH_FAILED'
  | 'REMOTE_REJECTED'
  | 'NETWORK'
  | 'CONFLICTS'
  | 'WORKTREE_DIRTY'
  | 'DIVERGED'
  | 'GIT_FAILED';

export class GitCommandFailure extends Error {
  constructor(
    readonly command: string,
    readonly code: GitFailureCode,
    readonly result: GitResult,
  ) {
    super(`git ${command} failed: ${(result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).slice(0, 2000)}`);
    this.name = 'GitCommandFailure';
  }
}

export function gitFailure(command: string, result: GitResult): GitCommandFailure {
  return new GitCommandFailure(command, classifyGitOutput(result), result);
}

/** Map Git's (English, LC_ALL=C) output to a failure class. */
export function classifyGitOutput(result: Pick<GitResult, 'stdout' | 'stderr' | 'timedOut'>): GitFailureCode {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (/index\.lock/.test(text)) return 'INDEX_LOCKED';
  if (/nothing to commit|no changes added to commit|nothing added to commit/.test(text)) return 'NOTHING_STAGED';
  if (/please tell me who you are|unable to auto-detect email|empty ident name/.test(text)) return 'IDENTITY_MISSING';
  if (/gpg failed to sign|error: cannot run gpg|failed to write commit object.*sign|ssh-keygen.*sign/.test(text)) return 'SIGNING_FAILED';
  if (
    /authentication failed|could not read username|could not read password|permission denied \(publickey|terminal prompts disabled|http 401|http 403|the requested url returned error: 40[13]|invalid username or password|access denied/.test(
      text,
    )
  )
    return 'REMOTE_AUTH_FAILED';
  if (/\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|pre-receive hook declined|protected branch|failed to push some refs/.test(text)) return 'REMOTE_REJECTED';
  if (/could not resolve host|unable to access|connection timed out|connection refused|network is unreachable|could not read from remote repository|operation timed out|ssl|early eof/.test(text) || result.timedOut)
    return 'NETWORK';
  if (/not possible to fast-forward|diverging branches|cannot fast-forward/.test(text)) return 'DIVERGED';
  if (/would be overwritten by merge|please commit your changes or stash them|untracked working tree files would be overwritten/.test(text)) return 'WORKTREE_DIRTY';
  if (/conflict|unmerged/.test(text)) return 'CONFLICTS';
  return 'GIT_FAILED';
}

/**
 * The remote answered that the repository does not exist (GitHub/GitLab 404,
 * or a local path that is no longer a repository). A private repository the
 * caller cannot see answers the same way, so callers must not treat this
 * alone as proof of deletion.
 */
export function remoteMissing(result: Pick<GitResult, 'stdout' | 'stderr'>): boolean {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return /repository not found|repository '[^']*' not found|does not appear to be a git repository|the requested url returned error: 404|project you were looking for could not be found/.test(text);
}

/**
 * `host/owner` of a remote URL (https, scp-style or ssh), or the parent folder
 * of a local path; lowercase and without credentials. Two repositories with the
 * same key live under the same account, which lets one successful fetch vouch
 * for the sign-in of the other.
 */
export function remoteOwnerKey(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(trimmed);
  if (withScheme && !/^file:/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const owner = parsed.pathname.split('/').filter(Boolean)[0];
      return owner ? `${parsed.hostname}/${owner}`.toLowerCase() : null;
    } catch {
      return null;
    }
  }
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)([^/\s]+)\//.exec(trimmed);
  if (scp && !/^[a-z]:[\\/]/i.test(trimmed)) return `${scp[1]}/${scp[2]}`.toLowerCase();
  const local = trimmed.replace(/^file:\/\//i, '').replace(/[\\/]+$/, '');
  const parent = local.replace(/[\\/][^\\/]*$/, '');
  return parent && parent !== local ? `local:${parent.replace(/\\/g, '/')}`.toLowerCase() : null;
}

export async function remoteUrl(cwd: string, remote: string): Promise<string | null> {
  const result = await git(cwd, ['remote', 'get-url', remote]);
  return result.code === 0 ? result.stdout.trim() || null : null;
}
