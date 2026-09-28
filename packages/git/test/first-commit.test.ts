import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { addWorktree, EMPTY_TREE, ensureFirstCommit, git, headCommit } from '../src/index.js';

let repo: string;

async function sh(args: string[]) {
  const r = await git(repo, args);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

beforeEach(async () => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'acc-first-'));
  await sh(['init', '-b', 'main']);
  await sh(['config', 'user.email', 'test@example.com']);
  await sh(['config', 'user.name', 'Test']);
});

describe('first commit of a repository with none', () => {
  it('adds an empty commit on the unborn branch without touching staged or untracked files', async () => {
    writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
    writeFileSync(path.join(repo, 'loose.txt'), 'loose\n');
    await sh(['add', 'staged.txt']);

    const first = await ensureFirstCommit(repo);

    expect(first?.branch).toBe('main');
    expect(await headCommit(repo)).toBe(first!.commit);
    expect(await sh(['rev-parse', `${first!.commit}^{tree}`])).toBe(EMPTY_TREE);
    expect(await sh(['log', '--format=%s', 'main'])).toBe('Initial commit');
    // The staged file is still staged (now as an addition), the loose one still untracked.
    const status = await sh(['status', '--porcelain']);
    expect(status).toContain('A  staged.txt');
    expect(status).toContain('?? loose.txt');
  });

  it('does nothing when the repository already has a commit', async () => {
    await sh(['commit', '--allow-empty', '-m', 'mine']);
    const head = await headCommit(repo);
    expect(await ensureFirstCommit(repo)).toBeNull();
    expect(await headCommit(repo)).toBe(head);
  });

  it('lets a task worktree be made from it', async () => {
    await ensureFirstCommit(repo);
    const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-first-wt-')), 'wt');
    const { branch, head } = await addWorktree(repo, dir, 'ai/TASK-0001-new-app');
    expect(branch).toBe('ai/TASK-0001-new-app');
    expect(head).toBe(await headCommit(repo));
  });
});
