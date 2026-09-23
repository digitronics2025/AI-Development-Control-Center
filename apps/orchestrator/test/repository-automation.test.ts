import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import { git, headCommit } from '@acc/git';
import type { Repository, RepositoryAutomationSettings } from '@acc/shared';
import { confirmGoneRemotes } from '../src/services/repository-automation.js';
import { reconcileGitOperations } from '../src/source-control/reconcile.js';
import { newId, now } from '../src/store/store.js';
import { addRepo, createTask, createTestApp, makeRepo, waitForStatus, type TestApp } from './helpers.js';

let t: TestApp;

beforeEach(async () => {
  SimulatedAgentAdapter.reset();
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

async function run(cwd: string, args: string[]) {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

async function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  await run(dir, ['init', '-b', 'main']);
}

async function automation(patch: Partial<RepositoryAutomationSettings>) {
  const current = t.services.settings.get().repositoryAutomation;
  const res = await t.api('PATCH', '/api/settings', { repositoryAutomation: { ...current, ...patch } });
  expect(res.status).toBe(200);
}

/** A repository whose `origin` is a local bare remote, plus a second clone that can push to it. */
async function repoWithRemote(): Promise<{ local: string; other: string; remote: string }> {
  const local = await makeRepo();
  const remote = mkdtempSync(path.join(os.tmpdir(), 'acc-remote-'));
  await run(remote, ['init', '--bare', '-b', 'main']);
  await run(local, ['remote', 'add', 'origin', remote]);
  await run(local, ['push', '-u', 'origin', 'main']);
  const other = mkdtempSync(path.join(os.tmpdir(), 'acc-other-'));
  await run(other, ['clone', remote, '.']);
  for (const [k, v] of [['user.email', 'o@example.com'], ['user.name', 'Other'], ['commit.gpgsign', 'false']]) await run(other, ['config', k!, v!]);
  return { local, other, remote };
}

async function commitIn(dir: string, file: string, content: string, message: string) {
  writeFileSync(path.join(dir, file), content);
  await run(dir, ['add', '--', file]);
  await run(dir, ['commit', '-m', message]);
}

const operations = (repoId: string) => t.services.gitOperations.list(repoId, 50);

describe('repository discovery', () => {
  it('registers standalone repositories within the depth, and nothing it must not', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'acc-discover-'));
    await initRepo(path.join(root, 'app'));
    await initRepo(path.join(root, 'group', 'service'));
    await initRepo(path.join(root, 'group', 'app')); // same name as a sibling: named group/app
    await initRepo(path.join(root, 'a', 'b', 'too-deep'));
    await initRepo(path.join(root, 'node_modules', 'dep'));
    await initRepo(path.join(root, '.hidden', 'secret'));
    mkdirSync(path.join(root, 'linked-worktree'));
    writeFileSync(path.join(root, 'linked-worktree', '.git'), 'gitdir: elsewhere/.git/worktrees/linked\n');
    mkdirSync(path.join(root, 'plain-folder'));

    await automation({ roots: [root], maxDepth: 2, sync: false });
    const report = await t.services.repositoryAutomation.discover();

    expect(report.errors).toEqual([]);
    expect(report.added.map((r) => path.relative(root, r.path)).sort()).toEqual(['app', path.join('group', 'app'), path.join('group', 'service')].sort());
    expect(report.added.map((r) => r.name).sort()).toEqual(['app', 'group/app', 'service']);
    const again = await t.services.repositoryAutomation.discover();
    expect(again.added).toEqual([]);
  });

  it('never brings back a removed repository, until it is added again by hand', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'acc-discover-'));
    await initRepo(path.join(root, 'keep'));
    await automation({ roots: [root], sync: false });
    const [added] = (await t.services.repositoryAutomation.discover()).added;
    expect((await t.api('DELETE', `/api/repositories/${added!.id}`)).status).toBe(204);
    expect(t.services.settings.get().repositoryAutomation.ignoredPaths).toEqual([added!.path]);

    expect((await t.services.repositoryAutomation.discover()).added).toEqual([]);

    const manual = await t.api('POST', '/api/repositories', { path: added!.path });
    expect(manual.status).toBe(201);
    expect(t.services.settings.get().repositoryAutomation.ignoredPaths).toEqual([]);
  });

  it('matches registered paths case-insensitively on Windows', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'acc-discover-'));
    await initRepo(path.join(root, 'Mixed'));
    await addRepo(t, path.join(root, 'Mixed'));
    await automation({ roots: [process.platform === 'win32' ? root.toUpperCase() : root], sync: false });
    expect((await t.services.repositoryAutomation.discover()).added).toEqual([]);
  });

  it('reports a missing root and skips the orchestrator data folder', async () => {
    const missing = path.join(os.tmpdir(), `acc-missing-${Date.now()}`);
    await initRepo(path.join(t.dataDir, 'inside-data'));
    await automation({ roots: [missing, t.dataDir], sync: false });
    const report = await t.services.repositoryAutomation.discover();
    expect(report.errors).toEqual([{ path: missing, message: 'Folder not found' }]);
    expect(report.added).toEqual([]);
  });

  it('rejects relative search folders', async () => {
    const current = t.services.settings.get().repositoryAutomation;
    const res = await t.api('PATCH', '/api/settings', { repositoryAutomation: { ...current, roots: ['relative/path'] } });
    expect(res.status).toBe(400);
  });
});

describe('background sync', () => {
  it('fast-forwards a clean branch that is only behind, journals it, and reports the new position', async () => {
    const { local, other } = await repoWithRemote();
    const repoId = await addRepo(t, local);
    await commitIn(other, 'remote.txt', 'from elsewhere\n', 'remote change');
    await run(other, ['push']);
    const remoteHead = await headCommit(other);

    const result = await t.services.sourceControl.backgroundSync(repoId);
    expect(result).toMatchObject({ outcome: 'fast-forwarded', ahead: 0, behind: 1 });
    expect(await headCommit(local)).toBe(remoteHead);
    const [op] = operations(repoId);
    expect(op).toMatchObject({ kind: 'fast_forward', status: 'succeeded', postHead: remoteHead });

    const repo: Repository = (await t.api('GET', `/api/repositories/${repoId}`)).body;
    expect(repo.status).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0, dirty: false });
  });

  it('downloads but leaves a branch with uncommitted changes where it is, without journalling', async () => {
    const { local, other } = await repoWithRemote();
    const repoId = await addRepo(t, local);
    await commitIn(other, 'remote.txt', 'x\n', 'remote change');
    await run(other, ['push']);
    writeFileSync(path.join(local, 'README.md'), 'my unsaved edit\n');
    const before = await headCommit(local);

    const result = await t.services.sourceControl.backgroundSync(repoId);
    expect(result).toMatchObject({ outcome: 'behind-dirty', behind: 1 });
    expect(await headCommit(local)).toBe(before);
    expect(operations(repoId)).toEqual([]);
    // The fetch still happened: the list shows what is waiting.
    expect((await t.services.repositories.get(repoId, true)).status).toMatchObject({ behind: 1, dirty: true });
  });

  it('never uploads: a branch that is ahead stays unpushed', async () => {
    const { local, remote } = await repoWithRemote();
    const repoId = await addRepo(t, local);
    await commitIn(local, 'mine.txt', 'local only\n', 'local change');
    const remoteBefore = (await run(remote, ['rev-parse', 'main'])).trim();

    const result = await t.services.sourceControl.backgroundSync(repoId);
    expect(result).toMatchObject({ outcome: 'ahead', ahead: 1, behind: 0 });
    expect((await run(remote, ['rev-parse', 'main'])).trim()).toBe(remoteBefore);
  });

  it('leaves a diverged branch alone', async () => {
    const { local, other } = await repoWithRemote();
    const repoId = await addRepo(t, local);
    await commitIn(other, 'remote.txt', 'r\n', 'remote change');
    await run(other, ['push']);
    await commitIn(local, 'local.txt', 'l\n', 'local change');
    const before = await headCommit(local);

    expect(await t.services.sourceControl.backgroundSync(repoId)).toMatchObject({ outcome: 'diverged', ahead: 1, behind: 1 });
    expect(await headCommit(local)).toBe(before);
  });

  it('skips repositories without an upstream or without a Git history', async () => {
    const noRemote = await addRepo(t, await makeRepo());
    expect(await t.services.sourceControl.backgroundSync(noRemote)).toMatchObject({ outcome: 'skipped' });
    const plain = mkdtempSync(path.join(os.tmpdir(), 'acc-plain-'));
    const plainId = (await t.api('POST', '/api/repositories', { path: plain })).body.id;
    expect(await t.services.sourceControl.backgroundSync(plainId)).toMatchObject({ outcome: 'skipped', message: 'Not a Git repository.' });
  });

  it('reports an unreachable remote as failed without touching the branch', async () => {
    const { local, remote } = await repoWithRemote();
    const repoId = await addRepo(t, local);
    await run(local, ['remote', 'set-url', 'origin', `${remote}-gone`]);
    const result = await t.services.sourceControl.backgroundSync(repoId);
    expect(result.outcome).toBe('failed');
    expect(result.message).toMatch(/Could not fetch origin/);
  });

  it('does not move the branch an unfinished task works on', async () => {
    const { local, other } = await repoWithRemote();
    const repoId = await addRepo(t, local);
    const taskId = await createTask(t, repoId, 'hold this branch', { mode: 'discuss' });
    await waitForStatus(t, taskId, ['WAITING_FOR_USER']);
    const branch = (await run(local, ['symbolic-ref', '--short', 'HEAD'])).trim();
    const record = t.services.store.getTask(taskId)!;
    t.services.store.updateTask(taskId, { git: { ...record.git, taskBranch: branch } });
    await commitIn(other, 'remote.txt', 'r\n', 'remote change');
    await run(other, ['push']);
    const before = await headCommit(local);

    const result = await t.services.sourceControl.backgroundSync(repoId);
    expect(result).toMatchObject({ outcome: 'skipped', behind: 1 });
    expect(result.message).toContain(taskId);
    expect(await headCommit(local)).toBe(before);
  });

  it('settles an automatic fast-forward interrupted by a restart from where HEAD is', async () => {
    const { local } = await repoWithRemote();
    const repoId = await addRepo(t, local);
    const head = (await headCommit(local))!;
    const op = t.services.gitOperations.start({
      id: newId(),
      repositoryId: repoId,
      idempotencyKey: `auto-ff-${newId()}`,
      kind: 'fast_forward',
      startedAt: now(),
      preHead: 'previous-head',
      preStateVersion: null,
      remote: null,
      ref: 'origin/main',
    });
    t.services.gitOperations.note(op.id, { fastForwardTo: head });
    const report = await reconcileGitOperations({ operations: t.services.gitOperations, repositories: t.services.repositories });
    expect(report.resolved).toEqual([{ id: op.id, kind: 'fast_forward', status: 'succeeded' }]);
  });
});

describe('deleted remotes', () => {
  it('calls a remote deleted only when another repository of the same account still fetches', async () => {
    const kept = await repoWithRemote();
    const gone = await repoWithRemote(); // remotes share a parent folder: the same "account"
    const keptId = await addRepo(t, kept.local);
    const goneId = await addRepo(t, gone.local);
    rmSync(gone.remote, { recursive: true, force: true });
    const before = await headCommit(gone.local);

    await automation({ discover: false, sync: true });
    const run = await t.services.repositoryAutomation.run('manual');
    expect(run.sync).toMatchObject({ 'up-to-date': 1, 'remote-gone': 1 });
    const results = t.services.repositoryAutomation.status().results;
    expect(results.find((r) => r.repositoryId === keptId)).toMatchObject({ outcome: 'up-to-date' });
    expect(results.find((r) => r.repositoryId === goneId)).toMatchObject({ outcome: 'remote-gone', remoteMissing: true });
    expect(await headCommit(gone.local)).toBe(before);
  });

  it('keeps a lone missing remote as failed: without proof the sign-in works, it may be an access problem', async () => {
    const gone = await repoWithRemote();
    const goneId = await addRepo(t, gone.local);
    rmSync(gone.remote, { recursive: true, force: true });
    await automation({ discover: false, sync: true });
    await t.services.repositoryAutomation.run('manual');
    expect(t.services.repositoryAutomation.status().results.find((r) => r.repositoryId === goneId)).toMatchObject({ outcome: 'failed', remoteMissing: true });
  });

  it('never vouches across accounts or for failures that are not "not found"', () => {
    const base = { message: '', ahead: null, behind: null, at: now() };
    const out = confirmGoneRemotes([
      { ...base, repositoryId: 'ok', outcome: 'up-to-date', remoteOwner: 'github.com/a', remoteMissing: false },
      { ...base, repositoryId: 'other-account', outcome: 'failed', remoteOwner: 'github.com/b', remoteMissing: true },
      { ...base, repositoryId: 'network', outcome: 'failed', remoteOwner: 'github.com/a', remoteMissing: false },
      { ...base, repositoryId: 'gone', outcome: 'failed', remoteOwner: 'github.com/a', remoteMissing: true },
    ]);
    expect(out.map((r) => [r.repositoryId, r.outcome])).toEqual([
      ['ok', 'up-to-date'],
      ['other-account', 'failed'],
      ['network', 'failed'],
      ['gone', 'remote-gone'],
    ]);
  });
});

describe('automation runs', () => {
  it('runs what settings enable, joins a run in progress, and keeps per-repository results', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'acc-discover-'));
    const { local, other } = await repoWithRemote();
    await initRepo(path.join(root, 'fresh'));
    const repoId = await addRepo(t, local);
    await commitIn(other, 'remote.txt', 'r\n', 'remote change');
    await run(other, ['push']);
    await automation({ roots: [root], discover: true, sync: true });

    const first = t.services.repositoryAutomation.run('manual');
    const joined = t.services.repositoryAutomation.run('manual');
    expect(joined).toBe(first);
    expect(t.services.repositoryAutomation.status().running).toBe(true);
    const done = await first;

    expect(done.discovery?.added.map((r) => r.name)).toEqual(['fresh']);
    expect(done.sync).toMatchObject({ 'fast-forwarded': 1 });
    const status = (await t.api('GET', '/api/repository-automation')).body;
    expect(status.running).toBe(false);
    expect(status.lastRun.finishedAt).toBeTruthy();
    expect(status.results.find((r: { repositoryId: string }) => r.repositoryId === repoId)).toMatchObject({ outcome: 'fast-forwarded' });

    await automation({ discover: false, sync: false });
    const off = await t.services.repositoryAutomation.run('manual');
    expect(off).toMatchObject({ discovery: null, sync: null });
  });

  it('starts a run from the API and answers before it finishes', async () => {
    await automation({ roots: [mkdtempSync(path.join(os.tmpdir(), 'acc-discover-'))], sync: false });
    const res = await t.api('POST', '/api/repository-automation/run');
    expect(res.status).toBe(202);
    expect(res.body.running).toBe(true);
    await t.services.repositoryAutomation.stop();
    expect(t.services.repositoryAutomation.status().running).toBe(false);
  });
});
