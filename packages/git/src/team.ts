import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { git, GitError, restoreCheckpoint, workingTreeTree, type RestoreResult } from './index.js';

/**
 * Stage Team isolation (docs/plans/STAGE_TEAMS_PLAN.md §3.7). Each write
 * worker gets a disposable detached checkout of a hidden checkpoint commit of
 * the task's working tree; its result is captured as another hidden commit,
 * and only the paths it changed are written back to the task — never with a
 * forced checkout or reset, and only while the task still matches the base.
 */

const CHECKPOINT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'AI Development Control Center',
  GIT_AUTHOR_EMAIL: 'checkpoints@localhost',
  GIT_COMMITTER_NAME: 'AI Development Control Center',
  GIT_COMMITTER_EMAIL: 'checkpoints@localhost',
};

/** Checkpoints keep bytes exactly; a child checkout must too, or every file would differ on Windows. */
const NO_EOL_CONVERSION = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];

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

/** The tree of a commit. */
export async function treeOf(cwd: string, commit: string): Promise<string> {
  assertObject(commit);
  return (await ok(cwd, ['rev-parse', `${commit}^{tree}`])).trim();
}

/** A detached checkout of `commit` at `dir`, bytes exactly as recorded (no line-ending conversion). */
export async function addChildWorktree(cwd: string, dir: string, commit: string): Promise<void> {
  assertObject(commit);
  const r = await git(cwd, [...NO_EOL_CONVERSION, 'worktree', 'add', '--detach', dir, commit], { timeoutMs: 300_000 });
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

/** Every path that differs between two commits, renames split into a deletion and an addition. */
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
  if (!TEAM_REF.test(ref) || ref.includes('..')) throw new Error(`Invalid team ref: ${ref}`);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const part of parts) {
    for (const c of part.changes) {
      if (seen.has(c.path)) throw new Error(`Two work units changed ${c.path}`);
      seen.add(c.path);
      lines.push(c.status === 'D' ? `0 ${'0'.repeat(40)}\t${c.path}` : `${c.mode} ${c.object}\t${c.path}`);
    }
  }
  const index = join(os.tmpdir(), `acc-team-index-${randomUUID()}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    await ok(cwd, ['read-tree', base], { env });
    if (lines.length) await ok(cwd, ['update-index', '-z', '--index-info'], { env, stdin: lines.join('\0') + '\0' });
    const tree = (await ok(cwd, ['write-tree'], { env })).trim();
    const commit = (await ok(cwd, ['commit-tree', tree, '-p', base, '-m', message], { env: CHECKPOINT_IDENTITY })).trim();
    await ok(cwd, ['update-ref', ref, commit]);
    return { commit, tree };
  } finally {
    await rm(index, { force: true });
  }
}

/**
 * Write `result`'s content for exactly `paths` into the working tree at `cwd`
 * — only when the working tree still equals `base` (nothing else wrote to it
 * since the team's wave started). Returns null when it does not: the caller
 * reports an integration conflict and nothing is written.
 */
export async function applyIfUnchanged(cwd: string, base: string, result: string, paths: ReadonlySet<string>): Promise<RestoreResult | null> {
  const [baseTree, current] = await Promise.all([treeOf(cwd, base), workingTreeTree(cwd)]);
  if (baseTree !== current) return null;
  return restoreCheckpoint(cwd, result, (p) => paths.has(p));
}
