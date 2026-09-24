import { afterEach, describe, expect, it } from 'vitest';
import { addRepo, createTask, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from './helpers.js';

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

describe('creating a task across repositories', () => {
  it('refuses a linked repository without Git or without a commit, and an unknown one, writing nothing', async () => {
    const { mkdtempSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    t = await createTestApp();
    const api = await addRepo(t, await makeRepo());
    const plain = await addRepo(t, mkdtempSync(path.join(os.tmpdir(), 'acc-plain-')));
    const before = t.services.store.listTasks({}).length;
    const res = await t.api('POST', '/api/tasks', { description: 'x', repositoryId: api, linkedRepositoryIds: [plain], workflowId: 'quick-change', mode: 'autopilot' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/is not a Git repository/);
    expect((await t.api('POST', '/api/tasks', { description: 'x', repositoryId: api, linkedRepositoryIds: ['nope'], workflowId: 'quick-change', mode: 'autopilot' })).status).toBe(404);
    expect(t.services.store.listTasks({}).length).toBe(before);
  });

  it('takes the most restrictive defaults and names every repository', async () => {
    t = await createTestApp();
    const api = await addRepo(t, await makeRepo());
    const web = await addRepo(t, await makeRepo());
    await t.api('PATCH', `/api/repositories/${web}`, { autoApproveUpToLevel: 1, policyMode: 'safe' });
    const id = await createTask(t, api, 'Across', { linkedRepositoryIds: [web], start: false, workflowId: 'quick-change' });
    const task = t.services.store.getTask(id)!;
    expect(task.autoApproveUpToLevel).toBe(1);
    expect(task.policyMode).toBe('safe');
    expect(task.git.isolated).toBe(true);
    expect(t.services.store.getRepository(web)!.lastTaskId).toBe(id);
    expect(t.services.store.listEvents(id).find((e) => e.type === 'TASK_CREATED')!.message).toContain(', ');
  });
});

describe('task workspace', () => {
  it('prepares one worktree per repository in one workspace and never touches the user trees', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { currentBranch, branchExists } = await import('@acc/git');
    t = await createTestApp();
    const apiPath = await makeRepo({ dirty: { 'notes.md': 'my api notes\n' } });
    const webPath = await makeRepo({ dirty: { 'notes.md': 'my web notes\n' } });
    const api = await addRepo(t, apiPath);
    const web = await addRepo(t, webPath);
    const id = await createTask(t, api, 'Change both', { linkedRepositoryIds: [web], workflowId: 'quick-change' });
    await waitFor(() => t!.services.store.listEvents(id).filter((e) => e.type === 'GIT_BASELINE').length, (n) => n === 2, 30_000, 'both baselines');
    const task = t.services.store.getTask(id)!;
    const linked = t.services.store.listLinkedRepositories(id)[0]!;
    expect(task.git.workspacePath).toBe(path.join(t.dataDir, 'workspaces', id));
    expect(task.git.worktreePath).toBe(path.join(task.git.workspacePath!, task.git.folder!));
    expect(linked.git.worktreePath).toBe(path.join(task.git.workspacePath!, linked.folder));
    expect(await branchExists(apiPath, task.git.taskBranch!)).toBe(true);
    expect(await branchExists(webPath, linked.git.taskBranch!)).toBe(true);
    await waitForStatus(t, id, ['COMPLETED', 'WAITING_FOR_USER', 'FAILED']);
    // The user's own working trees: same branch, same uncommitted file, no task file.
    for (const [repo, notes] of [[apiPath, 'my api notes\n'], [webPath, 'my web notes\n']] as const) {
      expect(await currentBranch(repo)).toBe('main');
      expect(readFileSync(path.join(repo, 'notes.md'), 'utf8')).toBe(notes);
      expect(existsSync(path.join(repo, 'sim-output.md'))).toBe(false);
    }
  });

  it('removes what it made when a repository cannot be prepared, waits, and succeeds on resume', async () => {
    const { renameSync } = await import('node:fs');
    const path = await import('node:path');
    const { git } = await import('@acc/git');
    t = await createTestApp();
    const apiPath = await makeRepo();
    const webPath = await makeRepo();
    const api = await addRepo(t, apiPath);
    const web = await addRepo(t, webPath);
    const id = await createTask(t, api, 'Fails on the second', { linkedRepositoryIds: [web], workflowId: 'quick-change', start: false });
    renameSync(path.join(webPath, '.git'), path.join(webPath, '.git-off'));
    await t.api('POST', `/api/tasks/${id}/start`);
    const parked = await waitForStatus(t, id, ['WAITING_FOR_USER', 'FAILED']);
    expect(parked.status).toBe('WAITING_FOR_USER');
    expect(parked.blocker?.message).toMatch(/^Could not prepare .+ for this task: .*Nothing was changed in your repositories/);
    expect(parked.git.baselineSnapshotId).toBeNull();
    expect(parked.git.worktreePath).toBeNull();
    const worktrees = await git(apiPath, ['worktree', 'list', '--porcelain']);
    expect(worktrees.stdout.match(/^worktree /gm)).toHaveLength(1);
    expect((await git(apiPath, ['branch', '--list', 'ai/*'])).stdout.trim()).toBe('');

    renameSync(path.join(webPath, '.git-off'), path.join(webPath, '.git'));
    expect((await t.api('POST', `/api/tasks/${id}/resume`)).status).toBeLessThan(300);
    // The first attempt baselined the primary and rolled it back, so wait for the linked repository itself.
    await waitFor(() => t!.services.store.listLinkedRepositories(id)[0]!.git.baselineSnapshotId, (v) => v !== null, 30_000, 'linked baseline after resume');
    expect(t.services.store.getTask(id)!.git.baselineSnapshotId).not.toBeNull();
    expect(t.services.store.getTask(id)!.git.workspacePath).not.toBeNull();
  });
});

describe('scheduling across repositories', () => {
  it('a task in a linked repository waits for the task across repositories, then starts', async () => {
    t = await createTestApp();
    const api = await addRepo(t, await makeRepo());
    const webPath = await makeRepo();
    const web = await addRepo(t, webPath);
    const multi = await createTask(t, api, 'Across [sim:slow]', { linkedRepositoryIds: [web], workflowId: 'quick-change' });
    await waitForStatus(t, multi, ['RUNNING']);
    const single = await createTask(t, web, 'Only web', { workflowId: 'quick-change' });
    const waiting = await waitFor(() => t!.services.store.getTask(single)!, (x) => x.blocker?.kind === 'queued', 30_000, 'queued blocker');
    expect(waiting.status).toBe('QUEUED');
    expect(waiting.blocker!.message).toBe(`Waiting for ${multi} (running) in the same repository (${t.services.store.getRepository(web)!.name})`);
    await waitForStatus(t, multi, ['COMPLETED', 'WAITING_FOR_USER', 'FAILED'], 120_000);
    await waitFor(() => t!.services.store.getTask(single)!.status, (s) => s !== 'QUEUED', 60_000, 'single task to start');
  }, 180_000);
});

describe('stages across repositories', () => {
  it('Full Autopilot runs each repository’s checks in its folder and commits on every task branch', async () => {
    const { git } = await import('@acc/git');
    t = await createTestApp();
    const apiPath = await makeRepo({ scripts: { test: 'node -e "console.log(\'3 passed\')"' } });
    const webPath = await makeRepo({ scripts: { test: 'node -e "console.log(\'5 passed\')"', lint: 'node -e "0"' } });
    const api = await addRepo(t, apiPath);
    const web = await addRepo(t, webPath);
    const id = await createTask(t, api, 'Change both sides', { linkedRepositoryIds: [web], workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 120_000);
    expect(done.status, JSON.stringify(done.blocker)).toBe('COMPLETED');
    const linked = t.services.store.listLinkedRepositories(id)[0]!;
    const apiFolder = done.git.folder!;
    const runs = t.services.store.listTestRuns(id).filter((r) => r.kind !== 'other');
    expect(runs.filter((r) => r.repositoryId === api).length).toBeGreaterThanOrEqual(1);
    expect(runs.filter((r) => r.repositoryId === api).every((r) => r.name.startsWith(`${apiFolder} · `))).toBe(true);
    expect(runs.filter((r) => r.repositoryId === web).length).toBeGreaterThanOrEqual(2);
    expect(runs.filter((r) => r.repositoryId === web).every((r) => r.name.startsWith(`${linked.folder} · `))).toBe(true);
    expect(runs.every((r) => r.status === 'passed')).toBe(true);
    // One commit per repository, each carrying that repository's change.
    expect(done.git.commits.length).toBeGreaterThanOrEqual(1);
    expect(linked.git.commits.length).toBeGreaterThanOrEqual(1);
    for (const [repo, branch] of [[apiPath, done.git.taskBranch!], [webPath, linked.git.taskBranch!]] as const) {
      const files = await git(repo, ['diff', '--name-only', `main..${branch}`]);
      expect(files.stdout).toContain('sim-output.md');
    }
    expect(t.services.store.listEvents(id).filter((e) => e.type === 'GIT_COMMIT').length).toBeGreaterThanOrEqual(2);
  }, 180_000);
});

describe('App check across repositories', () => {
  it('starts, checks and stops each repository’s app in turn', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    t = await createTestApp();
    const server = (port: number) => `require('http').createServer((q, s) => { s.setHeader('content-type', 'text/plain'); s.end('ok'); }).listen(${port}, '127.0.0.1');\n`;
    const ports = [20_000 + Math.floor(Math.random() * 10_000), 30_000 + Math.floor(Math.random() * 10_000)];
    const ids: string[] = [];
    for (const port of ports) {
      const id = await addRepo(t, await makeRepo({ files: { 'server.cjs': server(port) } }));
      await t.api('PATCH', `/api/repositories/${id}`, { runtime: { devCommand: 'node server.cjs', devUrl: `http://127.0.0.1:${port}`, verifyPaths: ['/'], verifyMode: 'http', readyTimeoutSec: 30 } });
      ids.push(id);
    }
    t.services.workflows.save('app-only', {
      name: 'App only',
      stages: [
        { key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, next: 'app' },
        { key: 'app', name: 'App check', role: 'tester', kind: 'verify', permissionLevel: 2, next: 'complete' },
      ],
    });
    const taskId = await createTask(t, ids[0]!, 'Check both apps', { linkedRepositoryIds: [ids[1]], workflowId: 'app-only', supervised: false });
    const done = await waitForStatus(t, taskId, ['COMPLETED', 'WAITING_FOR_USER', 'FAILED'], 180_000);
    expect(done.status, JSON.stringify(done.blocker)).toBe('COMPLETED');
    const checks = t.services.store.listTestRuns(taskId).filter((r) => r.kind === 'e2e');
    expect(checks.map((r) => [r.repositoryId, r.status])).toEqual([[ids[0], 'passed'], [ids[1], 'passed']]);
    const report = readFileSync(path.join(t.dataDir, 'tasks', taskId, 'browser-verification.md'), 'utf8');
    for (const port of ports) expect(report).toContain(`127.0.0.1:${port}`);
    expect(t.services.processes.list(taskId).every((p) => !['running', 'healthy', 'starting'].includes(p.status))).toBe(true);
  }, 240_000);
});

describe('finishing a task across repositories', () => {
  it('completion finalizes every worktree, removes the workspace and reports each repository', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { git } = await import('@acc/git');
    t = await createTestApp();
    const apiPath = await makeRepo();
    const webPath = await makeRepo();
    const api = await addRepo(t, apiPath);
    const web = await addRepo(t, webPath);
    const id = await createTask(t, api, 'Finish both', { linkedRepositoryIds: [web], workflowId: 'quick-change' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'WAITING_FOR_USER', 'FAILED'], 120_000);
    expect(done.status, JSON.stringify(done.blocker)).toBe('COMPLETED');
    const linked = t.services.store.listLinkedRepositories(id)[0]!;
    expect(done.git.workspacePath).toBeNull();
    expect(existsSync(path.join(t.dataDir, 'workspaces', id))).toBe(false);
    expect(done.git.worktreePath).toBeNull();
    expect(linked.git.worktreePath).toBeNull();
    for (const [repo, branch] of [[apiPath, done.git.taskBranch!], [webPath, linked.git.taskBranch!]] as const) {
      expect((await git(repo, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)).toHaveLength(1);
      // The remaining work was committed on the branch when the task completed.
      expect((await git(repo, ['diff', '--name-only', `main..${branch}`])).stdout).toContain('sim-output.md');
    }
    const patch = readFileSync(path.join(t.dataDir, 'tasks', id, 'git-diff.patch'), 'utf8');
    expect(patch).toContain(`b/${done.git.folder}/sim-output.md`);
    expect(patch).toContain(`b/${linked.folder}/sim-output.md`);
    const report = readFileSync(path.join(t.dataDir, 'tasks', id, 'final-report.md'), 'utf8');
    expect(report).toContain('- Repositories: ');
    expect(report).toContain(`- ${done.git.folder}/sim-output.md`);
    expect(report).toContain(`- ${linked.folder}/sim-output.md`);
    expect(report).toContain(`- Task branch: ${linked.git.taskBranch}`);
  }, 180_000);

  it('cancelling keeps each repository’s uncommitted work in a backup ref and removes the worktrees', async () => {
    const { existsSync, writeFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { git } = await import('@acc/git');
    t = await createTestApp();
    const apiPath = await makeRepo();
    const webPath = await makeRepo();
    const api = await addRepo(t, apiPath);
    const web = await addRepo(t, webPath);
    const id = await createTask(t, api, 'Cancel both [sim:slow]', { linkedRepositoryIds: [web], workflowId: 'quick-change' });
    await waitFor(() => t!.services.store.getTask(id)!.git.workspacePath, (v) => Boolean(v), 30_000, 'workspace');
    const task = t.services.store.getTask(id)!;
    const linked = t.services.store.listLinkedRepositories(id)[0]!;
    writeFileSync(path.join(task.git.worktreePath!, 'draft.md'), 'api draft\n');
    writeFileSync(path.join(linked.git.worktreePath!, 'draft.md'), 'web draft\n');
    expect((await t.api('POST', `/api/tasks/${id}/cancel`)).status).toBeLessThan(300);
    await waitForStatus(t, id, ['CANCELLED']);
    for (const repo of [apiPath, webPath]) {
      const ref = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/acc/worktree-backup/${id}`]);
      expect(ref.code).toBe(0);
      expect((await git(repo, ['show', `refs/acc/worktree-backup/${id}:draft.md`])).stdout).toMatch(/draft/);
      expect((await git(repo, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)).toHaveLength(1);
    }
    expect(existsSync(path.join(t.dataDir, 'workspaces', id))).toBe(false);
  }, 180_000);
});
