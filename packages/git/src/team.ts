import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { committableTree, git, GitError, headCommit, workingTreeTree, type RestoreResult } from './index.js';

/**
 * Stage Team isolation (docs/plans/STAGE_TEAMS_PLAN.md §3.7). Each write
 * worker gets a disposable detached checkout of a hidden commit of the task's
 * files; its result is captured as another hidden commit, and only the paths
 * it changed are written back to the task — never with a forced checkout or
 * reset, and only while the task still matches the base.
 *
 * Line endings (docs/systems/stage-teams.md): the commits hold what
 * `git add -A && git commit` would record (the repository's own autocrlf and
 * attributes), and checkouts and write-backs convert as a normal checkout
 * does. A worker therefore sees the task's files exactly as its own checkout
 * of them would look — `git status` clean at the start — and the task gets
 * back files in its usual convention. Only "the task is unchanged since the
 * base" compares byte-exact trees (`workingTreeTree`), with each other.
 */

const CHECKPOINT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'AI Development Control Center',
  GIT_AUTHOR_EMAIL: 'checkpoints@localhost',
  GIT_COMMITTER_NAME: 'AI Development Control Center',
  GIT_COMMITTER_EMAIL: 'checkpoints@localhost',
};

const OBJECT_ID = /^[0-9a-f]{40,64}$/;
const TEAM_REF = /^refs\/acc\/team\/[A-Za-z0-9._/-]+$/;

async function ok(cwd: string, args: string[], options: Parameters<typeof git>[2] = {}): Promise<string> {
  const r = await git(cwd, args, options);
  if (r.code !== 0) throw new GitError(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? args[0]} failed: ${(r.stderr || r.stdout).trim()}`, r);
  return r.stdout;
}

function assertObject(id: string): void {
  if (!OBJECT_ID.test(id)) throw new Error(`Not an object id: ${id}`);
}

function assertTeamRef(ref: string): void {
  if (!TEAM_REF.test(ref) || ref.includes('..')) throw new Error(`Invalid team ref: ${ref}`);
}

/** Run `fn` with a private, empty index file; the repository's own index is never read or written. */
async function withScratchIndex<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const index = join(os.tmpdir(), `acc-team-index-${randomUUID()}`);
  try {
    return await fn({ GIT_INDEX_FILE: index });
  } finally {
    await rm(index, { force: true });
  }
}

/** The tree of a commit (a tree id is returned as itself). */
export async function treeOf(cwd: string, commit: string): Promise<string> {
  assertObject(commit);
  return (await ok(cwd, ['rev-parse', `${commit}^{tree}`])).trim();
}

/** A commit of the files at `cwd` as a commit would record them, on top of its HEAD, kept alive by `ref`. */
async function commitCommittable(cwd: string, ref: string, message: string): Promise<{ commit: string; tree: string; head: string | null }> {
  assertTeamRef(ref);
  const [head, tree] = await Promise.all([headCommit(cwd), committableTree(cwd)]);
  const commit = (await ok(cwd, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], { env: CHECKPOINT_IDENTITY })).trim();
  await ok(cwd, ['update-ref', ref, commit]);
  return { commit, tree, head };
}

export interface WaveBase {
  /** What the workers start from: the task's files as a commit would record them, parent = the task's HEAD. */
  commit: string;
  tree: string;
  head: string | null;
  /** The task's files byte for byte at the same moment: what `applyIfUnchanged` compares the task with. */
  exactTree: string;
}

/**
 * The starting point of one write wave, recorded under `ref`. The byte-exact
 * tree comes first: if anything wrote to the task between the two reads, the
 * later check finds the task changed and writes nothing.
 */
export async function createWaveBase(cwd: string, ref: string, message: string): Promise<WaveBase> {
  const exactTree = await workingTreeTree(cwd);
  return { ...(await commitCommittable(cwd, ref, message)), exactTree };
}

/**
 * A worker's result: everything its checkout holds — new, deleted and binary
 * files included — as a commit would record it, on top of the checkout's
 * HEAD (the wave base), so a file that differs only in line endings is no change.
 */
export async function captureResult(cwd: string, ref: string, message: string): Promise<{ commit: string; tree: string }> {
  const { commit, tree } = await commitCommittable(cwd, ref, message);
  return { commit, tree };
}

/**
 * A detached checkout of `commit` at `dir` with the repository's usual
 * line-ending settings: its files look like the task's, and `git status` and
 * `git diff` inside it are clean until the worker changes something.
 */
export async function addChildWorktree(cwd: string, dir: string, commit: string): Promise<void> {
  assertObject(commit);
  const r = await git(cwd, ['worktree', 'add', '--detach', dir, commit], { timeoutMs: 300_000 });
  if (r.code !== 0) throw new GitError(`git worktree add failed: ${r.stderr.trim()}`, r);
}

export interface PathChange {
  /** A added, M modified, D deleted, T type changed (renames are reported as D + A). */
  status: 'A' | 'M' | 'D' | 'T';
  path: string;
  /** Mode and object in the result; null for a deletion. */
  mode: string | null;
  object: string | null;
}

/** Every path that differs between two commits (or trees), renames split into a deletion and an addition. */
export async function changedPathsBetween(cwd: string, base: string, result: string): Promise<PathChange[]> {
  assertObject(base);
  assertObject(result);
  const raw = await ok(cwd, ['diff-tree', '-r', '-z', '--no-renames', '--raw', base, result]);
  const parts = raw.split('\0');
  const out: PathChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!;
    const path = parts[i + 1]!;
    if (!meta.startsWith(':')) continue;
    // ":100644 100644 <old> <new> M"
    const [, newMode, , newObject, code] = meta.slice(1).split(' ');
    const status = (code?.[0] ?? 'M') as PathChange['status'];
    out.push({ status, path, mode: status === 'D' ? null : (newMode ?? null), object: status === 'D' ? null : (newObject ?? null) });
  }
  return out;
}

/**
 * One commit on top of `base` holding every part's changes (their paths must
 * not overlap), recorded under `ref`. Built in a private index: nothing in any
 * working tree, index or branch changes.
 */
export async function combineResults(cwd: string, base: string, parts: Array<{ changes: PathChange[] }>, ref: string, message: string): Promise<{ commit: string; tree: string }> {
  assertObject(base);
  assertTeamRef(ref);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const part of parts) {
    for (const c of part.changes) {
      if (seen.has(c.path)) throw new Error(`Two work units changed ${c.path}`);
      seen.add(c.path);
      lines.push(c.status === 'D' ? `0 ${'0'.repeat(40)}\t${c.path}` : `${c.mode} ${c.object}\t${c.path}`);
    }
  }
  return withScratchIndex(async (env) => {
    await ok(cwd, ['read-tree', base], { env });
    if (lines.length) await ok(cwd, ['update-index', '-z', '--index-info'], { env, stdin: lines.join('\0') + '\0' });
    const tree = (await ok(cwd, ['write-tree'], { env })).trim();
    const commit = (await ok(cwd, ['commit-tree', tree, '-p', base, '-m', message], { env: CHECKPOINT_IDENTITY })).trim();
    await ok(cwd, ['update-ref', ref, commit]);
    return { commit, tree };
  });
}

/**
 * Write `result`'s content for exactly `changes` into the working tree at
 * `cwd` — only while its files are still byte for byte `exactBase` (a tree
 * from `workingTreeTree`, or `WaveBase.exactTree`): nothing else wrote to it
 * since the wave started. Returns null when they are not: the caller reports
 * an integration conflict and nothing is written.
 */
export async function applyIfUnchanged(cwd: string, exactBase: string, result: string, changes: readonly PathChange[]): Promise<RestoreResult | null> {
  const [baseTree, current] = await Promise.all([treeOf(cwd, exactBase), workingTreeTree(cwd)]);
  if (baseTree !== current) return null;
  return writeChanges(cwd, result, changes);
}

/**
 * Put `commit`'s version of each changed path into the working tree the way
 * a checkout would (line endings converted by the repository's own settings,
 * binary files byte for byte); a deleted path is removed. Deletions go first,
 * so a file replaced by a folder of the same name (or back) can be written.
 * The repository's index, HEAD and every other path are left alone.
 */
async function writeChanges(cwd: string, commit: string, changes: readonly PathChange[]): Promise<RestoreResult> {
  assertObject(commit);
  const result: RestoreResult = { restored: [], removed: [], skipped: [] };
  for (const c of changes) {
    if (c.status !== 'D') continue;
    await rm(join(cwd, c.path), { force: true });
    result.removed.push(c.path);
  }
  const write = changes.filter((c) => c.status !== 'D').map((c) => c.path);
  if (write.length) {
    await withScratchIndex(async (env) => {
      await ok(cwd, ['read-tree', commit], { env });
      await ok(cwd, ['checkout-index', '-f', '-z', '--stdin'], { env, stdin: write.join('\0') + '\0' });
    });
    result.restored.push(...write);
  }
  return result;
}
