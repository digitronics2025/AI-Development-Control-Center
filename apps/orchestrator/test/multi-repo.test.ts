import { afterEach, describe, expect, it } from 'vitest';
import { addRepo, createTask, createTestApp, makeRepo, type TestApp } from './helpers.js';

/** Multi-repository tasks (docs/plans/MULTI_REPO_TASKS_PLAN.md). */

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe('store: linked repositories', () => {
  it('finds a task through a linked repository and refuses to forget that repository', async () => {
    t = await createTestApp();
    const api = await addRepo(t, await makeRepo());
    const web = await addRepo(t, await makeRepo());
    const id = await createTask(t, api, 'Store only', { start: false });
    t.services.store.insertLinkedRepositories([{ taskId: id, repositoryId: web, position: 1, folder: 'web', git: t.services.store.getTask(id)!.git }]);

    expect(t.services.store.listTasks({ repositoryId: web }).map((x) => x.id)).toEqual([id]);
    expect(t.services.store.listTasks({ repositoryId: api }).map((x) => x.id)).toEqual([id]);
    expect(t.services.store.countTasksForRepository(web)).toBe(1);
    expect(t.services.store.listLinkedRepositories(id)).toEqual([expect.objectContaining({ repositoryId: web, position: 1, folder: 'web' })]);
    expect((await t.api('DELETE', `/api/repositories/${web}`)).status).toBe(409);

    const version = t.services.store.getTask(id)!.version;
    t.services.store.updateLinkedRepositoryGit(id, web, { ...t.services.store.listLinkedRepositories(id)[0]!.git, taskBranch: 'ai/x' });
    expect(t.services.store.listLinkedRepositories(id)[0]!.git.taskBranch).toBe('ai/x');
    expect(t.services.store.getTask(id)!.version).toBe(version + 1);

    const summary = (await t.api('GET', `/api/tasks/${id}`)).body;
    expect(summary.repositories).toEqual([
      expect.objectContaining({ id: api, primary: true }),
      expect.objectContaining({ id: web, folder: 'web', primary: false }),
    ]);
  });
});
