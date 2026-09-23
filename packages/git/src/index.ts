import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runProcess } from '@acc/executor';
import type { ChangedFile } from '@acc/shared';

/** Git's well-known empty tree, used as the baseline of a repository with no commits. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when `maxOutputBytes` cut stdout short; the process was stopped. */
  truncated?: boolean;
  timedOut?: boolean;
}

export interface GitOptions {
  stdin?: string;
  timeoutMs?: number;
  /** Stop reading (and stop git) once stdout exceeds this many characters. */
  maxOutputBytes?: number;
  /** Extra environment, e.g. GIT_INDEX_FILE for a private index. */
  env?: NodeJS.ProcessEnv;
}

/** Hook and remote output can be enormous; only this much stderr is kept. */
const MAX_STDERR_CHARS = 64 * 1024;

export class GitError extends Error {
  constructor(
    message: string,
    readonly result: GitResult,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

/** Run git with an argv array (never a shell). Output is kept raw so `-z` records survive. */
export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  const out: string[] = [];
  const err: string[] = [];
  let outChars = 0;
  let errChars = 0;
  let truncated = false;
  const max = options.maxOutputBytes;
  const handle = runProcess({
    command: 'git',
    args: ['-c', 'core.quotepath=off', ...args],
    cwd,
    env: { ...process.env, ...GIT_ENV, ...options.env },
    stdin: options.stdin,
    timeoutMs: options.timeoutMs ?? 60_000,
    // `-z` output is one long NUL-separated record stream; never split it —
    // unless it is bounded, where any longer line is truncated anyway.
    maxLineLength: max !== undefined ? max + 1 : 256 * 1024 * 1024,
    onLine: (stream, line) => {
      if (stream === 'stderr') {
        if (errChars < MAX_STDERR_CHARS) err.push(line.slice(0, MAX_STDERR_CHARS - errChars));
        errChars += line.length + 1;
        return;
      }
      if (truncated) return;
      if (max !== undefined && outChars + line.length > max) {
        out.push(line.slice(0, Math.max(0, max - outChars)));
        truncated = true;
        void handle.cancel();
        return;
      }
      outChars += line.length + 1;
      out.push(line);
    },
  });
  const result = await handle.done;
  if (result.spawnError) throw new GitError(`git could not start: ${result.spawnError}`, { code: null, stdout: '', stderr: result.spawnError });
  return {
    code: result.exitCode,
    stdout: out.join('\n'),
    stderr: err.join('\n'),
    ...(truncated ? { truncated: true } : {}),
    ...(result.timedOut ? { timedOut: true } : {}),
  };
}

async function gitOk(cwd: string, args: string[], options?: GitOptions): Promise<string> {
  const result = await git(cwd, args, options);
  if (result.code !== 0) throw new GitError(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`, result);
  return result.stdout;
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const result = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return result.code === 0 && result.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function topLevel(cwd: string): Promise<string> {
  return (await gitOk(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

export async function headCommit(cwd: string): Promise<string | null> {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

export interface StatusEntry {
  path: string;
  /** Two-letter porcelain code, e.g. " M", "??", "R ". */
  code: string;
  origPath: string | null;
}

/** `git status --porcelain -z`, including untracked files. */
export async function status(cwd: string): Promise<StatusEntry[]> {
  const raw = await gitOk(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = raw.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    const file = record.slice(3);
    let origPath: string | null = null;
    if (code[0] === 'R' || code[0] === 'C') origPath = parts[++i] ?? null;
    entries.push({ path: file, code, origPath });
  }
  return entries;
}

/** Content hashes of working-tree files (null for deleted files). */
export async function hashFiles(cwd: string, paths: string[]): Promise<Record<string, string | null>> {
  const hashes: Record<string, string | null> = {};
  if (paths.length === 0) return hashes;
  const existing = paths.filter((p) => existsSync(join(cwd, p)));
  for (const p of paths) hashes[p] = null;
  if (existing.length) {
    const out = await gitOk(cwd, ['hash-object', '--stdin-paths'], { stdin: existing.join('\n') + '\n' });
    const lines = out.split('\n').filter(Boolean);
    existing.forEach((p, i) => (hashes[p] = lines[i] ?? null));
  }
  return hashes;
}

export interface GitSnapshot {
  branch: string | null;
  head: string | null;
  files: Array<{ path: string; code: string; hash: string | null }>;
}

/** Record what the working tree looks like before a task touches it. */
export async function snapshot(cwd: string): Promise<GitSnapshot> {
  const [branch, head, entries] = await Promise.all([currentBranch(cwd), headCommit(cwd), status(cwd)]);
  const hashes = await hashFiles(
    cwd,
    entries.map((e) => e.path),
  );
  return { branch, head, files: entries.map((e) => ({ path: e.path, code: e.code, hash: hashes[e.path] ?? null })) };
}

export async function branchExists(cwd: string, name: string): Promise<boolean> {
  const result = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  return result.code === 0;
}

export function taskBranchName(taskId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `ai/${taskId}${slug ? `-${slug}` : ''}`;
}

/** The task a branch made by `taskBranchName` belongs to, or null for any other branch. */
export function taskIdFromBranch(branch: string | null): string | null {
  return (branch ? /^ai\/(TASK-\d+)(?:-|$)/.exec(branch)?.[1] : undefined) ?? null;
}

/**
 * Create and switch to a task branch. `git switch -c` never touches the
 * working tree, so uncommitted user work comes along untouched.
 */
export async function createTaskBranch(cwd: string, name: string): Promise<string> {
  let candidate = name;
  for (let n = 2; await branchExists(cwd, candidate); n++) candidate = `${name}-${n}`;
  if (!(await headCommit(cwd))) {
    // Unborn branch: switching would fail; name the unborn branch instead.
    await gitOk(cwd, ['symbolic-ref', 'HEAD', `refs/heads/${candidate}`]);
    return candidate;
  }
  await gitOk(cwd, ['switch', '-c', candidate]);
  return candidate;
}

export function parseNumstat(raw: string): Map<string, { additions: number | null; deletions: number | null }> {
  const map = new Map<string, { additions: number | null; deletions: number | null }>();
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record) continue;
    const [add, del, file] = record.split('\t');
    let path = file;
    if (path === '' || path === undefined) {
      // Rename: "add\tdel\t\0old\0new"
      i += 1;
      path = parts[++i];
    }
    if (!path) continue;
    map.set(path, {
      additions: add === '-' ? null : Number(add),
      deletions: del === '-' ? null : Number(del),
    });
  }
  return map;
}

function statusFromCode(code: string): ChangedFile['status'] {
  if (code === '??') return 'untracked';
  if (code.includes('D')) return 'deleted';
  if (code.includes('R')) return 'renamed';
  if (code.includes('A')) return 'added';
  return 'modified';
}

async function countLines(cwd: string, file: string): Promise<number | null> {
  try {
    const content = await readFile(join(cwd, file));
    if (content.includes(0)) return null;
    const text = content.toString('utf8');
    return text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return null;
  }
}

/**
 * Everything that differs from the task baseline, attributed:
 * - `task`: not dirty at baseline, so the task created the change
 * - `preexisting`: dirty at baseline and unchanged since
 * - `both`: dirty at baseline and modified again during the task
 */
export async function changesSince(cwd: string, baseline: GitSnapshot): Promise<ChangedFile[]> {
  const base = baseline.head ?? EMPTY_TREE;
  const [numstatRaw, entries] = await Promise.all([
    git(cwd, ['diff', '--numstat', '-z', '-M', base]).then((r) => (r.code === 0 ? r.stdout : '')),
    status(cwd),
  ]);
  const numstat = parseNumstat(numstatRaw);
  const baselineByPath = new Map(baseline.files.map((f) => [f.path, f]));

  // Files changed relative to the baseline commit: tracked diffs plus current untracked files.
  const paths = new Set<string>([...numstat.keys(), ...entries.filter((e) => e.code === '??').map((e) => e.path)]);
  // Files dirty at baseline that are now clean (the task reverted user work) still matter.
  for (const f of baseline.files) if (!paths.has(f.path)) paths.add(f.path);

  const currentHashes = await hashFiles(cwd, [...paths]);
  const statusByPath = new Map(entries.map((e) => [e.path, e]));
  const files: ChangedFile[] = [];
  for (const path of [...paths].sort()) {
    const before = baselineByPath.get(path);
    const current = statusByPath.get(path);
    const stat = numstat.get(path);
    if (!before && !stat && !current) continue;
    let origin: ChangedFile['origin'];
    if (!before) origin = 'task';
    else if (before.hash === (currentHashes[path] ?? null)) origin = 'preexisting';
    else origin = 'both';
    if (before && !stat && !current && origin === 'preexisting') continue;
    const fileStatus = current ? statusFromCode(current.code) : 'modified';
    let additions = stat?.additions ?? null;
    let deletions = stat?.deletions ?? null;
    if (!stat && current?.code === '??') {
      additions = await countLines(cwd, path);
      deletions = 0;
    }
    files.push({ path, status: fileStatus, additions, deletions, origin });
  }
  return files;
}

/** Unified diff against the baseline, including untracked files, bounded in size. */
export async function diffSince(
  cwd: string,
  baseline: GitSnapshot,
  options: { path?: string; maxBytes?: number } = {},
): Promise<{ diff: string; truncated: boolean }> {
  const base = baseline.head ?? EMPTY_TREE;
  const maxBytes = options.maxBytes ?? 2_000_000;
  const pathArgs = options.path ? ['--', options.path] : [];
  const tracked = await git(cwd, ['diff', '--no-color', '-M', base, ...pathArgs]);
  let diff = tracked.code === 0 ? tracked.stdout : '';
  const untracked = (await status(cwd)).filter(
    (e) => e.code === '??' && (!options.path || e.path === options.path),
  );
  for (const entry of untracked) {
    if (diff.length > maxBytes) break;
    const result = await git(cwd, ['diff', '--no-color', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', entry.path]);
    // --no-index exits 1 when files differ; that is the expected case.
    if (result.stdout) diff += (diff && !diff.endsWith('\n') ? '\n' : '') + result.stdout;
  }
  if (diff.length > maxBytes) return { diff: diff.slice(0, maxBytes), truncated: true };
  return { diff, truncated: false };
}

/** Stage exactly the given paths and commit them. Returns the new commit hash. */
export async function commitPaths(cwd: string, paths: string[], message: string): Promise<string | null> {
  if (paths.length === 0) return null;
  await gitOk(cwd, ['add', '--all', '--', ...paths]);
  const staged = await git(cwd, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return null;
  // Repository hooks run as usual; the orchestrator never bypasses them.
  await gitOk(cwd, ['commit', '-m', message, '--', ...paths]);
  return headCommit(cwd);
}

// ---------------------------------------------------------------------------
// Checkpoints (docs/systems/git.md). A checkpoint is a commit object of the
// whole working tree, built in a private index and kept alive by a hidden
// ref. The user's index, HEAD, branches and files are never touched by
// creating one; restoring one rewrites only the paths the caller allows.
// ---------------------------------------------------------------------------

/** Internal objects need an identity even in repositories without one configured. */
const CHECKPOINT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'AI Development Control Center',
  GIT_AUTHOR_EMAIL: 'checkpoints@localhost',
  GIT_COMMITTER_NAME: 'AI Development Control Center',
  GIT_COMMITTER_EMAIL: 'checkpoints@localhost',
};

/** Checkpoints must round-trip bytes exactly, whatever core.autocrlf says. */
const NO_EOL_CONVERSION = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];

async function withPrivateIndex<T>(cwd: string, fn: (env: NodeJS.ProcessEnv) => Promise<T>, seedFromRealIndex = true): Promise<T> {
  const tmp = join(os.tmpdir(), `acc-index-${randomUUID()}`);
  try {
    if (seedFromRealIndex) {
      // Copying the real index keeps its stat cache, so only changed files are re-hashed.
      const rel = (await gitOk(cwd, ['rev-parse', '--git-path', 'index'])).trim();
      const real = isAbsolute(rel) ? rel : join(cwd, rel);
      if (existsSync(real)) await copyFile(real, tmp);
    }
    return await fn({ GIT_INDEX_FILE: tmp });
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Tree of the working tree as it is now (tracked and untracked, .gitignore respected). */
export async function workingTreeTree(cwd: string): Promise<string> {
  return withPrivateIndex(cwd, async (env) => {
    await gitOk(cwd, [...NO_EOL_CONVERSION, 'add', '-A'], { env });
    return (await gitOk(cwd, ['write-tree'], { env })).trim();
  });
}

export interface CheckpointResult {
  commit: string;
  tree: string;
  head: string | null;
}

/** Record the working tree under `ref` (e.g. refs/acc/checkpoints/TASK-0001/3). */
export async function createCheckpoint(cwd: string, ref: string, message: string): Promise<CheckpointResult> {
  if (!/^refs\/acc\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..')) throw new Error(`Invalid checkpoint ref: ${ref}`);
  const head = await headCommit(cwd);
  const tree = await workingTreeTree(cwd);
  const commit = (await gitOk(cwd, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], { env: CHECKPOINT_IDENTITY })).trim();
  await gitOk(cwd, ['update-ref', ref, commit]);
  return { commit, tree, head };
}

export interface RestoreResult {
  /** Paths written back to their checkpoint content. */
  restored: string[];
  /** Paths created after the checkpoint and deleted again. */
  removed: string[];
  /** Paths that differ but were not touched because the caller does not own them. */
  skipped: string[];
}

/**
 * Put the working tree back to `commit` for every path that changed since it,
 * except paths `mayTouch` rejects. Nothing outside those paths is modified;
 * the user's index and HEAD are left alone.
 */
export async function restoreCheckpoint(cwd: string, commit: string, mayTouch: (path: string) => boolean): Promise<RestoreResult> {
  const checkpointTree = (await gitOk(cwd, ['rev-parse', `${commit}^{tree}`])).trim();
  const currentTree = await workingTreeTree(cwd);
  const raw = await gitOk(cwd, ['diff-tree', '-r', '--no-renames', '--name-status', '-z', checkpointTree, currentTree]);
  const parts = raw.split('\0').filter((p) => p !== '');
  const result: RestoreResult = { restored: [], removed: [], skipped: [] };
  const toRestore: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i]!;
    const file = parts[i + 1]!;
    if (!mayTouch(file)) {
      result.skipped.push(file);
      continue;
    }
    if (code.startsWith('A')) {
      await rm(join(cwd, file), { force: true });
      result.removed.push(file);
    } else {
      toRestore.push(file);
    }
  }
  if (toRestore.length) {
    await withPrivateIndex(
      cwd,
      async (env) => {
        await gitOk(cwd, ['read-tree', checkpointTree], { env });
        await gitOk(cwd, [...NO_EOL_CONVERSION, 'checkout-index', '-f', '-z', '--stdin'], { env, stdin: toRestore.join('\0') + '\0' });
      },
      false,
    );
    result.restored.push(...toRestore);
  }
  return result;
}

/** Delete hidden checkpoint refs under a prefix (their objects become collectable). */
export async function deleteRefs(cwd: string, prefix: string): Promise<number> {
  if (!prefix.startsWith('refs/acc/')) throw new Error(`Refusing to delete refs outside refs/acc/: ${prefix}`);
  const refs = (await gitOk(cwd, ['for-each-ref', '--format=%(refname)', prefix])).split('\n').filter(Boolean);
  for (const ref of refs) await gitOk(cwd, ['update-ref', '-d', ref]);
  return refs.length;
}

export * from './source-control.js';
