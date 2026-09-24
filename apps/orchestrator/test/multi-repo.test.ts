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

describe('task repositories accessor', () => {
  it('answers exactly as before for a single-repository task, and lists linked ones in order', async () => {
    const { agentWorkdir, inFolder, isMultiRepository, taskRepositories, taskRepository, taskRepositoryIds } = await import('../src/engine/task-repositories.js');
    t = await createTestApp();
    const apiPath = await makeRepo();
    const api = await addRepo(t, apiPath);
    const web = await addRepo(t, await makeRepo());
    const id = await createTask(t, api, 'Accessor', { start: false });
    const store = t.services.store;
    const single = taskRepositories(store, store.getTask(id)!);
    expect(single).toEqual([expect.objectContaining({ primary: true, folder: null, workdir: store.getRepository(api)!.path })]);
    expect(agentWorkdir(store.getTask(id)!, store.getRepository(api)!)).toBe(store.getRepository(api)!.path);
    expect(isMultiRepository(store, { id })).toBe(false);
    expect(inFolder(null, 'src/a.ts')).toBe('src/a.ts');

    store.insertLinkedRepositories([{ taskId: id, repositoryId: web, position: 1, folder: 'web', git: { ...store.getTask(id)!.git, worktreePath: '/ws/web' } }]);
    store.updateTask(id, { git: { ...store.getTask(id)!.git, workspacePath: '/ws', worktreePath: '/ws/api', folder: 'api' } });
    const task = store.getTask(id)!;
    expect(taskRepositoryIds(store, task)).toEqual([api, web]);
    expect(taskRepositories(store, task).map((r) => [r.repo.id, r.folder, r.workdir, r.primary])).toEqual([
      [api, 'api', '/ws/api', true],
      [web, 'web', '/ws/web', false],
    ]);
    expect(taskRepository(store, task, web)?.folder).toBe('web');
    expect(agentWorkdir(task, store.getRepository(api)!)).toBe('/ws');
    expect(isMultiRepository(store, task)).toBe(true);
    expect(inFolder('web', 'src/a.ts')).toBe('web/src/a.ts');
  });
});
