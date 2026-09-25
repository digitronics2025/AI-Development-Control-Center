import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addWorktree, changedPaths, commitsInRange, committableTree, fetchBranch, git, pushRef, remoteBranchHead, removeWorktree, revParse, treeOfCommit, workingTreeTree } from '../src/index.js';

/** Git helpers a release relies on (docs/plans/RELEASE_STAGE_PLAN.md §3.4), against a real bare remote. */

async function run(cwd: string, args: string[]) {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

async function commitFile(cwd: string, file: string, content: string, message: string) {
  writeFileSync(path.join(cwd, file), content);
  await run(cwd, ['add', '--', file]);
  await run(cwd, ['commit', '-m', message]);
  return run(cwd, ['rev-parse', 'HEAD']);
}

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'acc-release-git-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  await run(root, ['init', '--bare', '-b', 'main', remote]);
  await run(root, ['init', '-b', 'main', local]);
  for (const args of [['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['config', 'commit.gpgsign', 'false'], ['remote', 'add', 'origin', remote]]) await run(local, args);
  const base = await commitFile(local, 'README.md', '# app\n', 'init');
  await run(local, ['push', '-u', 'origin', 'main']);
  return { root, remote, local, base };
}

describe('release git helpers', () => {
  it('pushes one commit from a removed worktree to the remote branch, fast-forward only, without touching the folder', async () => {
    const { root, remote, local, base } = await setup();
    const wt = path.join(root, 'wt');
    await addWorktree(local, wt, 'ai/TASK-0001-x');
    for (const args of [['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T']]) await run(wt, args);
    const sha = await commitFile(wt, 'feature.txt', 'hello\n', 'feature');
    expect(await removeWorktree(local, wt, { force: true })).toBe(true);

    const before = { head: await run(local, ['rev-parse', 'HEAD']), branch: await run(local, ['branch', '--show-current']), status: await run(local, ['status', '--porcelain']) };
    const push = await pushRef(local, { sha, remote: 'origin', remoteRef: 'refs/heads/main', setUpstream: false });
    expect(push.code).toBe(0);
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(sha);
    // The operator's folder is exactly as it was: same HEAD, same branch, same (clean) status.
    expect({ head: await run(local, ['rev-parse', 'HEAD']), branch: await run(local, ['branch', '--show-current']), status: await run(local, ['status', '--porcelain']) }).toEqual(before);

    expect((await fetchBranch(local, 'origin', 'main')).code).toBe(0);
    expect(await revParse(local, 'refs/remotes/origin/main')).toBe(sha);
    expect(await commitsInRange(local, base, sha)).toEqual([sha]);
    expect(await changedPaths(local, base, sha)).toEqual(['feature.txt']);
    expect(await treeOfCommit(local, sha)).toMatch(/^[0-9a-f]{40}$/);
    expect(await treeOfCommit(local, 'f'.repeat(40))).toBeNull();
    const head = await remoteBranchHead(local, 'origin', 'main');
    expect(head).toEqual({ ok: true, sha });
    expect(await remoteBranchHead(local, 'origin', 'nope')).toEqual({ ok: true, sha: null });
  });

  it('is rejected when the remote branch moved (never forced), and has no force option at all', async () => {
    const { root, remote, local } = await setup();
    const other = path.join(root, 'other');
    await run(root, ['clone', remote, other]);
    for (const args of [['config', 'user.email', 'o@example.com'], ['config', 'user.name', 'O']]) await run(other, args);
    await commitFile(other, 'other.txt', 'o\n', 'someone else');
    await run(other, ['push']);
    const mine = await commitFile(local, 'mine.txt', 'm\n', 'mine');
    const rejected = await pushRef(local, { sha: mine, remote: 'origin', remoteRef: 'refs/heads/main', setUpstream: false });
    expect(rejected.code).not.toBe(0);
    expect(rejected.lines[0]?.flag).toBe('!');
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).not.toBe(mine);
    // The signature offers no force; input that tries to smuggle one in is refused before git runs.
    await expect(pushRef(local, { sha: `+${mine}`, remote: 'origin', remoteRef: 'refs/heads/main', setUpstream: false })).rejects.toThrow(/full commit id/);
    await expect(pushRef(local, { sha: mine, remote: '--force', remoteRef: 'refs/heads/main', setUpstream: false })).rejects.toThrow(/remote name/);
    await expect(pushRef(local, { sha: mine, remote: 'origin', remoteRef: 'refs/tags/v1', setUpstream: false })).rejects.toThrow(/branch ref/);
    await expect(pushRef(local, { sha: mine, remote: 'origin', remoteRef: 'refs/heads/a..b', setUpstream: false })).rejects.toThrow(/plain branch/);
  });

  it('reads the tree a commit of the working tree would record, even where line endings are converted', async () => {
    const { local } = await setup();
    await run(local, ['config', 'core.autocrlf', 'true']);
    writeFileSync(path.join(local, 'crlf.txt'), 'one\r\ntwo\r\n');
    const committable = await committableTree(local);
    const exact = await workingTreeTree(local);
    const sha = await commitFile(local, 'crlf.txt', 'one\r\ntwo\r\n', 'crlf');
    // The commit normalizes CRLF to LF: only the committable tree equals it.
    expect(await treeOfCommit(local, sha)).toBe(committable);
    expect(exact).not.toBe(committable);
    // Reading it never writes the real index.
    expect(await run(local, ['status', '--porcelain'])).toBe('');
  });
});
