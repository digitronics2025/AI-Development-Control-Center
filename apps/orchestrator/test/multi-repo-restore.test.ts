import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addRepo, createTask, createTestApp, makeRepo, waitForStatus, type TestApp } from './helpers.js';

/**
 * Multi-repository tasks (docs/plans/MULTI_REPO_TASKS_PLAN.md §5): a rollback
 * that fails in the second repository — after it already changed files there —
 * puts every repository back as it was before the rollback.
 */
const failIn = { dir: '' };
vi.mock('@acc/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@acc/git')>();
  return {
    ...actual,
    restoreCheckpoint: async (cwd: string, commit: string, mayTouch: (p: string) => boolean) => {
      if (failIn.dir && path.resolve(cwd) === path.resolve(failIn.dir)) {
        failIn.dir = ''; // fail once, after really changing the files, like a lock hit half-way
        await actual.restoreCheckpoint(cwd, commit, mayTouch);
        throw new Error('disk full');
      }
      return actual.restoreCheckpoint(cwd, commit, mayTouch);
    },
  };
});

let t: TestApp | null = null;
afterEach(async () => {
  failIn.dir = '';
  await t?.close();
  t = null;
});

describe('rollback across repositories, failing part-way', () => {
  it('puts back the repositories already rolled back and the one that failed half-way', async () => {
    t = await createTestApp();
    const api = await addRepo(t, await makeRepo());
    const web = await addRepo(t, await makeRepo());
    const id = await createTask(t, api, 'Part-way [sim:needs-decision]', { linkedRepositoryIds: [web], workflowId: 'quick-change', supervised: false });
    await waitForStatus(t, id, ['WAITING_FOR_USER', 'COMPLETED', 'FAILED']);
    const task = t.services.store.getTask(id)!;
    const webDir = t.services.store.listLinkedRepositories(id)[0]!.git.worktreePath!;
    const apiDir = task.git.worktreePath!;
    writeFileSync(path.join(apiDir, 'a.txt'), 'api one\n');
    writeFileSync(path.join(webDir, 'a.txt'), 'web one\n');
    const cp = (await t.services.chairman.checkpoints.create(task, { label: 'one', reason: 'user' }))!;
    writeFileSync(path.join(apiDir, 'a.txt'), 'api two\n');
    writeFileSync(path.join(webDir, 'a.txt'), 'web two\n');
    failIn.dir = webDir;
    await expect(t.services.chairman.checkpoints.restore(t.services.store.getTask(id)!, cp.id)).rejects.toThrow(/Rollback of .+ failed \(disk full\); every repository was put back as it was before the rollback/);
    expect(readFileSync(path.join(apiDir, 'a.txt'), 'utf8')).toBe('api two\n');
    // web had really been rolled back to "one" before the failure; it is back to "two".
    expect(readFileSync(path.join(webDir, 'a.txt'), 'utf8')).toBe('web two\n');
  }, 120_000);
});
