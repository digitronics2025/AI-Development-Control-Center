import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addRepo, createTask, createTestApp, makeRepo, waitForStatus, type TestApp } from './helpers.js';

/**
 * Multi-repository tasks (docs/plans/MULTI_REPO_TASKS_PLAN.md §5): a rollback
 * that fails in the second repository puts the first one back.
 */
const failIn = { dir: '' };
vi.mock('@acc/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@acc/git')>();
  return {
    ...actual,
    restoreCheckpoint: (cwd: string, commit: string, mayTouch: (p: string) => boolean) =>
      failIn.dir && path.resolve(cwd) === path.resolve(failIn.dir) ? Promise.reject(new Error('disk full')) : actual.restoreCheckpoint(cwd, commit, mayTouch),
  };
});

let t: TestApp | null = null;
afterEach(async () => {
  failIn.dir = '';
  await t?.close();
  t = null;
});

describe('rollback across repositories, failing part-way', () => {
  it('restores the repositories already rolled back and reports the one that failed', async () => {
    t = await createTestApp();
    const api = await addRepo(t, await makeRepo());
    const web = await addRepo(t, await makeRepo());
    const id = await createTask(t, api, 'Part-way [sim:needs-decision]', { linkedRepositoryIds: [web], workflowId: 'quick-change', supervised: false });
    await waitForStatus(t, id, ['WAITING_FOR_USER', 'COMPLETED', 'FAILED']);
    const task = t.services.store.getTask(id)!;
    const webRepo = t.services.store.listLinkedRepositories(id)[0]!;
    const apiDir = task.git.worktreePath!;
    writeFileSync(path.join(apiDir, 'a.txt'), 'api one\n');
    const cp = (await t.services.chairman.checkpoints.create(task, { label: 'one', reason: 'user' }))!;
    writeFileSync(path.join(apiDir, 'a.txt'), 'api two\n');
    failIn.dir = webRepo.git.worktreePath!;
    await expect(t.services.chairman.checkpoints.restore(t.services.store.getTask(id)!, cp.id)).rejects.toThrow(/Rollback of .+ failed \(disk full\); the repositories already rolled back were put back/);
    // api was rolled back to "one", then put back to "two" when web failed.
    expect(readFileSync(path.join(apiDir, 'a.txt'), 'utf8')).toBe('api two\n');
  }, 120_000);
});
