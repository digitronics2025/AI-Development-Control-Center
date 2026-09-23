import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangedFile } from '@acc/shared';
import { branchExists, currentBranch, EMPTY_TREE, git, GitError, headCommit, parseNumstat, status } from './index.js';

/**
 * Task worktrees (docs/plans/tool-layer-v2 §15): a task can run in its own
 * checkout on its own branch, so the user's working tree — including their
 * uncommitted work — is never touched while it runs.
 */

export async function addWorktree(repo: string, dir: string, branchName: string): Promise<{ branch: string; head: string }> {
  const head = await headCommit(repo);
  if (!head) throw new GitError('A worktree needs at least one commit in the repository', { code: 1, stdout: '', stderr: 'no commits' });
  let branch = branchName;
  for (let n = 2; await branchExists(repo, branch); n++) branch = `${branchName}-${n}`;
  const r = await git(repo, ['worktree', 'add', '-b', branch, dir, head], { timeoutMs: 300_000 });
  if (r.code !== 0) throw new GitError(`git worktree add failed: ${r.stderr.trim()}`, r);
  return { branch, head };
}

/** Remove a worktree. Without `force`, Git refuses when it has uncommitted changes. */
export async function removeWorktree(repo: string, dir: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const r = await git(repo, ['worktree', 'remove', ...(opts.force ? ['--force'] : []), dir], { timeoutMs: 120_000 });
  if (r.code !== 0 && opts.force && existsSync(dir)) {
    // Locked files on Windows (a server still exiting) can defeat git; clear the folder and prune.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
  }
  await git(repo, ['worktree', 'prune']);
  return !existsSync(dir);
}

/** Changes a task made on its branch, for views after its worktree is gone. */
export async function changesInRange(repo: string, base: string | null, tip: string): Promise<ChangedFile[]> {
  const from = base ?? EMPTY_TREE;
  const [numstat, names] = await Promise.all([git(repo, ['diff', '--numstat', '-z', '-M', from, tip]), git(repo, ['diff', '--name-status', '-z', '-M', from, tip])]);
  if (numstat.code !== 0) return [];
  const stats = parseNumstat(numstat.stdout);
  const parts = names.stdout.split('\0').filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!;
    const renamed = code.startsWith('R') || code.startsWith('C');
    const path = renamed ? parts[i + 2]! : parts[i + 1]!;
    i += renamed ? 2 : 1;
    const s = stats.get(path);
    files.push({ path, status: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : renamed ? 'renamed' : 'modified', additions: s?.additions ?? null, deletions: s?.deletions ?? null, origin: 'task' });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function diffInRange(repo: string, base: string | null, tip: string, opts: { path?: string; maxBytes?: number } = {}): Promise<{ diff: string; truncated: boolean }> {
  const max = opts.maxBytes ?? 2_000_000;
  const r = await git(repo, ['diff', '--no-color', '-M', base ?? EMPTY_TREE, tip, ...(opts.path ? ['--', opts.path] : [])], { maxOutputBytes: max });
  return { diff: r.code === 0 || r.truncated ? r.stdout : '', truncated: Boolean(r.truncated) };
}

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'poetry.lock', 'requirements.txt', 'Cargo.lock', 'go.sum', 'gradle.lockfile'];

/** What a checkpoint records besides the tree: enough to explain and compare, no file contents. */
export async function checkpointMetadata(cwd: string): Promise<Record<string, unknown>> {
  const [branch, head, entries] = await Promise.all([currentBranch(cwd), headCommit(cwd), status(cwd).catch(() => [])]);
  const lockfiles: Record<string, string> = {};
  for (const name of LOCKFILES) {
    const file = join(cwd, name);
    if (!existsSync(file)) continue;
    try {
      lockfiles[name] = createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 16);
    } catch {
      /* unreadable: skip */
    }
  }
  return {
    branch,
    head,
    dirtyCount: entries.length,
    dirtyFiles: entries.slice(0, 200).map((e) => `${e.code.trim() || 'M'} ${e.path}`),
    lockfiles,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  };
}
