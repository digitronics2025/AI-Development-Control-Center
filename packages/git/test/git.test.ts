import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  changesSince,
  commitPaths,
  createCheckpoint,
  createTaskBranch,
  deleteRefs,
  currentBranch,
  diffSince,
  git,
  headCommit,
  isGitRepository,
  restoreCheckpoint,
  snapshot,
  taskBranchName,
  taskIdFromBranch,
} from '../src/index.js';

let repo: string;

async function sh(args: string[]) {
  const r = await git(repo, args);
  if (r.code !== 0) throw new Error(r.stderr);
  return r.stdout;
}

beforeEach(async () => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'acc-git-'));
  await sh(['init', '-b', 'main']);
  await sh(['config', 'user.email', 'test@example.com']);
  await sh(['config', 'user.name', 'Test']);
  await sh(['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  writeFileSync(path.join(repo, 'b.txt'), 'bee\n');
  await sh(['add', '.']);
  await sh(['commit', '-m', 'init']);
});

describe('git helpers', () => {
  it('detects repositories', async () => {
    expect(await isGitRepository(repo)).toBe(true);
    expect(await isGitRepository(mkdtempSync(path.join(os.tmpdir(), 'acc-nogit-')))).toBe(false);
  });

  it('attributes changes to the task vs pre-existing user work', async () => {
    // User work present before the task starts.
    writeFileSync(path.join(repo, 'a.txt'), 'one\nuser edit\n');
    writeFileSync(path.join(repo, 'user-notes.md'), 'draft\n');
    const baseline = await snapshot(repo);
    expect(baseline.files.map((f) => f.path).sort()).toEqual(['a.txt', 'user-notes.md']);

    const branch = await createTaskBranch(repo, taskBranchName('TASK-0001', 'Add feature: sync!'));
    expect(branch).toBe('ai/TASK-0001-add-feature-sync');
    expect(taskIdFromBranch(branch)).toBe('TASK-0001');
    expect(taskIdFromBranch('ai/TASK-0002')).toBe('TASK-0002');
    expect(taskIdFromBranch('main')).toBeNull();
    expect(taskIdFromBranch('ai/TASK-12x')).toBeNull();
    expect(taskIdFromBranch(null)).toBeNull();
    expect(await currentBranch(repo)).toBe(branch);
    // Switching branches kept the user's uncommitted work intact.
    expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('one\nuser edit\n');

    // Task edits: new file, edit of a clean file, and an edit on top of a user-modified file.
    writeFileSync(path.join(repo, 'feature.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(repo, 'b.txt'), 'bee\nbuzz\n');
    writeFileSync(path.join(repo, 'user-notes.md'), 'draft\nagent line\n');

    const files = await changesSince(repo, baseline);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['feature.ts']).toMatchObject({ origin: 'task', status: 'untracked', additions: 1 });
    expect(byPath['b.txt']).toMatchObject({ origin: 'task', status: 'modified', additions: 1, deletions: 0 });
    expect(byPath['a.txt']).toMatchObject({ origin: 'preexisting' });
    expect(byPath['user-notes.md']).toMatchObject({ origin: 'both' });

    const { diff } = await diffSince(repo, baseline);
    expect(diff).toContain('+buzz');
    expect(diff).toContain('feature.ts');
    const single = await diffSince(repo, baseline, { path: 'b.txt' });
    expect(single.diff).toContain('+buzz');
    expect(single.diff).not.toContain('feature.ts');
  });

  it('commits only the given paths, leaving user work uncommitted', async () => {
    writeFileSync(path.join(repo, 'a.txt'), 'user change\n');
    const baseline = await snapshot(repo);
    writeFileSync(path.join(repo, 'new.ts'), 'x\n');
    const before = await headCommit(repo);
    const commit = await commitPaths(repo, ['new.ts'], 'TASK-0001: add new.ts');
    expect(commit).not.toBe(before);
    const stillDirty = await changesSince(repo, baseline);
    expect(stillDirty.find((f) => f.path === 'a.txt')?.origin).toBe('preexisting');
    expect(await commitPaths(repo, [], 'nothing')).toBeNull();
  });

  it('handles a repository with no commits', async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'acc-git-empty-'));
    await git(empty, ['init', '-b', 'main']);
    const baseline = await snapshot(empty);
    expect(baseline.head).toBeNull();
    writeFileSync(path.join(empty, 'x.txt'), 'hello\n');
    const files = await changesSince(empty, baseline);
    expect(files).toEqual([expect.objectContaining({ path: 'x.txt', origin: 'task' })]);
    const branch = await createTaskBranch(empty, 'ai/TASK-0002');
    expect(await currentBranch(empty)).toBe(branch);
  });
});

describe('checkpoints', () => {
  it('records the working tree without touching the index, HEAD or files', async () => {
    writeFileSync(path.join(repo, 'a.txt'), 'staged\n');
    await sh(['add', 'a.txt']);
    writeFileSync(path.join(repo, 'a.txt'), 'staged then edited\n');
    writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    const head = await headCommit(repo);
    const statusBefore = await sh(['status', '--porcelain']);
    const cp = await createCheckpoint(repo, 'refs/acc/checkpoints/TASK-0001/1', 'checkpoint 1');
    expect(cp.head).toBe(head);
    expect(await headCommit(repo)).toBe(head);
    expect(await sh(['status', '--porcelain'])).toBe(statusBefore);
    expect(await sh(['show', `${cp.commit}:new.txt`])).toBe('untracked');
    expect(await sh(['show', `${cp.commit}:a.txt`])).toBe('staged then edited');
    expect((await sh(['rev-parse', 'refs/acc/checkpoints/TASK-0001/1'])).trim()).toBe(cp.commit);
    await expect(createCheckpoint(repo, 'refs/heads/main', 'nope')).rejects.toThrow('Invalid checkpoint ref');
  });

  it('restores only the paths it may touch and deletes files added since', async () => {
    writeFileSync(path.join(repo, 'user.txt'), 'user work\n');
    writeFileSync(path.join(repo, 'task.txt'), 'task v1\n');
    const cp = await createCheckpoint(repo, 'refs/acc/checkpoints/TASK-0001/1', 'before fix');
    writeFileSync(path.join(repo, 'task.txt'), 'task v2 (bad)\n');
    writeFileSync(path.join(repo, 'extra.txt'), 'added by the bad fix\n');
    writeFileSync(path.join(repo, 'user.txt'), 'user kept typing\n');
    const result = await restoreCheckpoint(repo, cp.commit, (p) => p !== 'user.txt');
    expect(result.restored).toEqual(['task.txt']);
    expect(result.removed).toEqual(['extra.txt']);
    expect(result.skipped).toEqual(['user.txt']);
    expect(readFileSync(path.join(repo, 'task.txt'), 'utf8')).toBe('task v1\n');
    expect(readFileSync(path.join(repo, 'user.txt'), 'utf8')).toBe('user kept typing\n');
    expect(existsSync(path.join(repo, 'extra.txt'))).toBe(false);
    // The user's index was never modified.
    expect(await sh(['diff', '--cached', '--name-only'])).toBe('');
  });

  it('deletes only refs under refs/acc/', async () => {
    await createCheckpoint(repo, 'refs/acc/checkpoints/TASK-0009/1', 'one');
    await createCheckpoint(repo, 'refs/acc/checkpoints/TASK-0009/2', 'two');
    expect(await deleteRefs(repo, 'refs/acc/checkpoints/TASK-0009/')).toBe(2);
    await expect(deleteRefs(repo, 'refs/heads/')).rejects.toThrow('Refusing');
  });
});
