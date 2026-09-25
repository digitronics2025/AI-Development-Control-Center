import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { git } from '@acc/git';
import { validateWorkflow, type ReleaseConfigInput, type TaskRelease } from '@acc/shared';
import { recoveryCandidates } from '../src/chairman/policy.js';
import type { Probe } from '../src/release/service.js';
import { bodyNamesCommit } from '../src/release/service.js';
import { addRepo, createTask, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from './helpers.js';

/**
 * Releases (docs/plans/RELEASE_STAGE_PLAN.md): the Release stage and button
 * against a real bare remote, a stand-in live site and a stand-in Cloudflare
 * API. Every refusal is checked to have sent nothing.
 */

async function run(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repository with a bare `origin` it has pushed main to. */
async function releaseRepo(): Promise<{ repo: string; remote: string }> {
  const repo = await makeRepo();
  const remote = path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-remote-')), 'origin.git');
  await run(os.tmpdir(), ['init', '--bare', '-b', 'main', remote]);
  await run(repo, ['remote', 'add', 'origin', remote]);
  await run(repo, ['push', '-u', 'origin', 'main']);
  return { repo, remote };
}

/** What the stand-in live site serves: a host that deploys whatever main on `origin` points at. */
const site = { remote: '', up: true, showsCommit: true };
const remoteMain = () => run(site.remote, ['rev-parse', 'refs/heads/main']);
const probe: Probe = async (url) => {
  if (!url.startsWith('https://live.test')) return { status: null, body: '', error: 'unknown host' };
  if (!site.up) return { status: null, body: '', error: 'connection refused' };
  if (url.startsWith('https://live.test/version')) return { status: 200, body: site.showsCommit ? JSON.stringify({ commit: await remoteMain() }) : '{"commit":"unknown"}', error: null };
  return { status: 200, body: '<!doctype html><title>app</title>', error: null };
};

/** Stand-in Cloudflare API: the Pages project serves main on `origin` once "built", or reports a failed build. */
const pages = { mode: 'serves-main' as 'serves-main' | 'build-failed' };
let cfServer: http.Server;
let cfBase = '';
const ACCOUNT = '0123456789abcdef0123456789abcdef';

beforeAll(async () => {
  cfServer = http.createServer((req, res) => {
    void (async () => {
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      const u = new URL(req.url!, 'http://x');
      const base = `/cf/accounts/${ACCOUNT}/pages/projects/shop`;
      const head = site.remote ? await remoteMain() : 'c'.repeat(40);
      const dep = (id: string, commit: string, status: string) => ({ id, url: `https://${id}.shop.pages.dev`, latest_stage: { name: 'deploy', status }, deployment_trigger: { metadata: { commit_hash: commit, branch: 'main' } }, created_on: new Date().toISOString() });
      const old = dep('old-deployment', 'd'.repeat(40), 'success');
      const canonical = pages.mode === 'serves-main' ? dep('new-deployment', head, 'success') : old;
      if (u.pathname === base) return json(200, { success: true, result: { name: 'shop', production_branch: 'main', canonical_deployment: canonical } });
      if (u.pathname === `${base}/deployments`) return json(200, { success: true, result: pages.mode === 'build-failed' ? [dep('failed-deployment', head, 'failure'), old] : [canonical] });
      json(404, { success: false, errors: [{ message: 'not found' }] });
    })();
  });
  await new Promise<void>((resolve) => cfServer.listen(0, '127.0.0.1', resolve));
  cfBase = `http://127.0.0.1:${(cfServer.address() as AddressInfo).port}/cf`;
});

afterAll(() => {
  cfServer.close();
});

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
  site.up = true;
  site.showsCommit = true;
  pages.mode = 'serves-main';
});

const VERSION_PROOF: ReleaseConfigInput = { method: 'push', remote: 'origin', branch: 'main', liveUrl: 'https://live.test/', proof: { versionUrl: 'https://live.test/version' }, manualPaths: ['db/migrations/**'], timeoutSec: 60 };

async function app(): Promise<TestApp> {
  return createTestApp({ release: { probe, pollSeconds: 0.05 }, baseEnv: { ...process.env, ACC_CF_API_BASE: cfBase } });
}

async function setup(release: ReleaseConfigInput | null = VERSION_PROOF) {
  t = await app();
  const { repo, remote } = await releaseRepo();
  site.remote = remote;
  const repositoryId = await addRepo(t, repo, release ? { release } : undefined);
  const before = { remote: await run(remote, ['rev-parse', 'refs/heads/main']), head: await run(repo, ['rev-parse', 'HEAD']), branch: await run(repo, ['branch', '--show-current']), status: await run(repo, ['status', '--porcelain']) };
  return { repo, remote, repositoryId, before };
}

async function folderState(repo: string) {
  return { head: await run(repo, ['rev-parse', 'HEAD']), branch: await run(repo, ['branch', '--show-current']), status: await run(repo, ['status', '--porcelain']) };
}

async function fullTask(repositoryId: string, description = 'Add a feature') {
  return createTask(t!, repositoryId, description, { workflowId: 'full-autopilot', supervised: false });
}

const releaseApproval = (taskId: string) => t!.services.store.listApprovals({ taskId }).filter((a) => a.status === 'pending').at(-1);
const release = (taskId: string): TaskRelease | null => t!.services.store.getTask(taskId)!.git.release ?? null;
const events = (taskId: string) => t!.services.store.listEvents(taskId, { limit: 5000 });

async function waitRelease(taskId: string, states: TaskRelease['state'][], timeoutMs = 30_000): Promise<TaskRelease> {
  return waitFor(() => release(taskId), (r) => r !== null && states.includes(r.state), timeoutMs, `release of ${taskId} to reach ${states.join('/')}`) as Promise<TaskRelease>;
}

/** Run the task to its Release approval; deny it so the task completes with nothing sent. */
async function completedUnreleased(repositoryId: string) {
  const id = await fullTask(repositoryId);
  await waitFor(() => releaseApproval(id), (a) => a !== undefined, 90_000, 'the release approval');
  expect((await t!.api('POST', `/api/approvals/${releaseApproval(id)!.id}/deny`, {})).status).toBe(200);
  await waitForStatus(t!, id, ['COMPLETED'], 30_000);
  return id;
}

describe('Release stage', () => {
  it('is skipped without asking when the repository has no release set up', async () => {
    const { repositoryId, remote, before } = await setup(null);
    const id = await fullTask(repositoryId);
    const task = await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(task.status).toBe('COMPLETED');
    const stage = t!.services.store.listStages(id).find((s) => s.stageKey === 'release')!;
    expect(stage).toMatchObject({ status: 'SKIPPED', summary: 'No release set up for this repository' });
    expect(t!.services.store.listApprovals({ taskId: id }).filter((a) => a.stageKey === 'release')).toEqual([]);
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(before.remote);
    expect(task.git.release ?? null).toBeNull();
    // The tree the checks ran on is recorded (§3.3).
    expect(t!.services.store.listTestRuns(id).some((r) => r.status === 'passed' && /^[0-9a-f]{40}$/.test(r.treeId ?? ''))).toBe(true);
  }, 120_000);

  it('asks one typed Level 5 approval, then sends only the tested commit and proves it live', async () => {
    const { repo, remote, repositoryId, before } = await setup();
    const id = await fullTask(repositoryId);
    const approval = await waitFor(() => releaseApproval(id), (a) => a !== undefined, 90_000, 'the release approval');
    const task = t!.services.store.getTask(id)!;
    const sha = task.git.commits.at(-1)!;
    expect(approval).toMatchObject({ kind: 'stage_permission', stageKey: 'release', permissionLevel: 5, confirmationPhrase: id, environment: 'production' });
    expect(approval!.action).toBe(`Push ${sha.slice(0, 7)} to origin/main`);
    expect(approval!.reason).toContain('Releasing sends work to your live site');
    expect(approval!.reason).toContain(`Live when https://live.test/version shows ${sha.slice(0, 7)}`);
    // Nothing is sent before the approval.
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(before.remote);
    expect(events(id).some((e) => e.type === 'RELEASE_REQUESTED')).toBe(true);

    // The typed task id is required.
    expect((await t!.api('POST', `/api/approvals/${approval!.id}/approve`, {})).status).toBe(422);
    expect((await t!.api('POST', `/api/approvals/${approval!.id}/approve`, { confirmation: id })).status).toBe(200);
    const done = await waitForStatus(t!, id, ['COMPLETED'], 60_000);

    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(sha);
    expect(done.git.release).toMatchObject({ state: 'live', commit: sha, via: 'stage', target: { remote: 'origin', branch: 'main', liveUrl: 'https://live.test/' } });
    expect(done.git.release!.liveConfirmedAt).toBeTruthy();
    expect(done.git.release!.evidence.versionUrl).toMatchObject({ ok: true });
    expect(done.finalStatus).toBe('READY');
    const stage = t!.services.store.listStages(id).filter((s) => s.stageKey === 'release').at(-1)!;
    expect(stage.status).toBe('SUCCESS');
    expect(stage.summary).toContain('Live on https://live.test/');
    const types = events(id).map((e) => e.type);
    for (const type of ['RELEASE_REQUESTED', 'RELEASE_APPROVED', 'RELEASE_PUBLISHED', 'RELEASE_LIVE'] as const) expect(types).toContain(type);
    const report = t!.services.store.listArtifacts(id).find((a) => a.name === 'final-report.md')!;
    const text = (await t!.services.artifacts.read(report, 200_000)).content;
    expect(text).toContain(`Live on https://live.test/ since ${done.git.release!.liveConfirmedAt} — commit ${sha.slice(0, 10)}`);
    expect(t!.services.store.listArtifacts(id).some((a) => a.name === 'release.md')).toBe(true);
    // The operator's folder is untouched: same HEAD, branch and status.
    expect(await folderState(repo)).toEqual({ head: before.head, branch: before.branch, status: before.status });
  }, 150_000);

  it('a Chairman-supervised task releases through the same typed approval', async () => {
    const { remote, repositoryId } = await setup();
    const id = await createTask(t!, repositoryId, 'Add a feature', { workflowId: 'full-autopilot', supervised: true });
    const approval = await waitFor(() => releaseApproval(id), (a) => a !== undefined, 120_000, 'the release approval');
    expect(approval!.confirmationPhrase).toBe(id);
    expect((await t!.api('POST', `/api/approvals/${approval!.id}/approve`, { confirmation: id })).status).toBe(200);
    const done = await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.git.release?.state).toBe('live');
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(done.git.commits.at(-1));
  }, 180_000);

  it('declining sends nothing, completes the task, and the Release button releases it later', async () => {
    const { remote, repositoryId, before } = await setup();
    const id = await completedUnreleased(repositoryId);
    const stage = t!.services.store.listStages(id).filter((s) => s.stageKey === 'release').at(-1)!;
    expect(stage).toMatchObject({ status: 'SKIPPED', summary: 'Release declined' });
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(before.remote);
    expect(events(id).map((e) => e.type)).toContain('RELEASE_DECLINED');

    const requested = await t!.api('POST', `/api/tasks/${id}/release`, {});
    expect(requested.status).toBe(202);
    expect(requested.body.approval).toMatchObject({ kind: 'release', permissionLevel: 5, confirmationPhrase: id });
    // The task keeps its status: a completed task is not parked on the button's approval.
    expect(t!.services.store.getTask(id)!.status).toBe('COMPLETED');
    // Asking twice returns the same pending approval.
    expect((await t!.api('POST', `/api/tasks/${id}/release`, {})).body.approval.id).toBe(requested.body.approval.id);
    expect((await t!.api('POST', `/api/approvals/${requested.body.approval.id}/approve`, { confirmation: id })).status).toBe(200);
    const live = await waitRelease(id, ['live', 'failed', 'refused', 'published_unconfirmed']);
    expect(live).toMatchObject({ state: 'live', via: 'button' });
    const sha = t!.services.store.getTask(id)!.git.commits.at(-1)!;
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(sha);
    const synthetic = t!.services.store.listStages(id).filter((s) => s.stageKey === 'release').at(-1)!;
    expect(synthetic).toMatchObject({ kind: 'release', status: 'SUCCESS' });
    // Live on the same commit: the button is not offered again.
    expect((await t!.api('POST', `/api/tasks/${id}/release`, {})).status).toBe(409);
  }, 150_000);
});

describe('Refusals send nothing', () => {
  it('refuses when the target branch moved since the task started', async () => {
    const { remote, repositoryId } = await setup();
    const id = await completedUnreleased(repositoryId);
    const other = mkdtempSync(path.join(os.tmpdir(), 'acc-other-'));
    await run(os.tmpdir(), ['clone', remote, other]);
    for (const args of [['config', 'user.email', 'o@example.com'], ['config', 'user.name', 'O'], ['config', 'commit.gpgsign', 'false']]) await run(other, args);
    writeFileSync(path.join(other, 'elsewhere.txt'), 'x\n');
    await run(other, ['add', '.']);
    await run(other, ['commit', '-m', 'someone else']);
    await run(other, ['push']);
    const moved = await run(remote, ['rev-parse', 'refs/heads/main']);
    const res = await t!.api('POST', `/api/tasks/${id}/release`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RELEASE_REFUSED');
    expect(res.body.error.message).toContain('main has moved since this task started. Update the task and re-test first.');
    expect(release(id)).toMatchObject({ state: 'refused' });
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(moved);
    expect(t!.services.store.listApprovals({ taskId: id }).some((a) => a.kind === 'release')).toBe(false);
  }, 150_000);

  it('refuses a commit whose files are not the ones the checks passed on', async () => {
    const { remote, repositoryId, before } = await setup();
    const id = await completedUnreleased(repositoryId);
    for (const r of t!.services.store.listTestRuns(id)) if (r.treeId) t!.services.store.updateTestRun(r.id, { treeId: 'f'.repeat(40) });
    let res = await t!.api('POST', `/api/tasks/${id}/release`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('This commit is not the version that passed the checks. Run the checks again on it, then release.');
    for (const r of t!.services.store.listTestRuns(id)) t!.services.store.updateTestRun(r.id, { treeId: null });
    res = await t!.api('POST', `/api/tasks/${id}/release`, {});
    expect(res.body.error.message).toBe('No record of which version passed the checks — run the checks again.');
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(before.remote);
  }, 150_000);

  it('refuses a change to a manual path, secret material, a site that is not answering — each after the approval, before any push', async () => {
    const { repo, remote, repositoryId, before } = await setup({ ...VERSION_PROOF, manualPaths: ['db/migrations/**'] });
    const id = await completedUnreleased(repositoryId);
    const approveButton = async () => {
      const since = new Date().toISOString();
      const req = await t!.api('POST', `/api/tasks/${id}/release`, {});
      expect(req.status).toBe(202);
      expect((await t!.api('POST', `/api/approvals/${req.body.approval.id}/approve`, { confirmation: id })).status).toBe(200);
      return waitFor(() => release(id), (r) => r !== null && r.requestedAt >= since && !['publishing', 'proving'].includes(r.state), 30_000, 'the release to end') as Promise<TaskRelease>;
    };
    // A later commit on the task branch that the checks "passed" but that touches db/migrations and carries a secret.
    const addTaskCommit = async (files: Record<string, string>) => {
      const current = t!.services.store.getTask(id)!;
      const tip = current.git.commits.at(-1)!;
      const wt = mkdtempSync(path.join(os.tmpdir(), 'acc-wt-'));
      await run(repo, ['worktree', 'add', '--detach', wt, tip]);
      for (const args of [['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test'], ['config', 'commit.gpgsign', 'false']]) await run(wt, args);
      for (const [file, content] of Object.entries(files)) {
        await import('node:fs').then((fs) => fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true }));
        writeFileSync(path.join(wt, file), content);
      }
      await run(wt, ['add', '.']);
      await run(wt, ['commit', '-m', 'more']);
      const sha = await run(wt, ['rev-parse', 'HEAD']);
      const tree = await run(wt, ['rev-parse', 'HEAD^{tree}']);
      await run(repo, ['worktree', 'remove', '--force', wt]);
      t!.services.store.updateTask(id, { git: { ...current.git, commits: [...current.git.commits, sha] } });
      const passed = t!.services.store.listTestRuns(id).filter((r) => r.status === 'passed').at(-1)!;
      t!.services.store.updateTestRun(passed.id, { treeId: tree, finishedAt: new Date(Date.now() + 60_000).toISOString() });
      return sha;
    };

    // The site is down: nothing is sent.
    site.up = false;
    let r = await approveButton();
    expect(r).toMatchObject({ state: 'refused' });
    expect(r.reason).toContain("The live site isn't answering");
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(before.remote);
    site.up = true;

    await addTaskCommit({ 'db/migrations/0002_add.sql': 'ALTER TABLE x ADD y;\n' });
    r = await approveButton();
    expect(r).toMatchObject({ state: 'refused' });
    expect(r.reason).toBe('These need a manual step (for example a database migration): db/migrations/0002_add.sql.');
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(before.remote);

    await t!.api('PATCH', `/api/repositories/${repositoryId}`, { release: { ...VERSION_PROOF, manualPaths: [] } });
    const secret = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    await addTaskCommit({ 'config.ts': `export const token = '${secret}';\n` });
    r = await approveButton();
    expect(r).toMatchObject({ state: 'refused' });
    expect(r.reason).toContain('The commits to send include secret material: config.ts');
    expect(r.reason).not.toContain(secret);
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(before.remote);
    expect(events(id).filter((e) => e.type === 'RELEASE_REFUSED').length).toBeGreaterThanOrEqual(3);
  }, 180_000);

  it('a rejected push is a failure, reported with the remote’s words', async () => {
    const { remote, repositoryId, before } = await setup();
    const id = await completedUnreleased(repositoryId);
    const hook = path.join(remote, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "branch is protected" >&2\nexit 1\n', { mode: 0o755 });
    const req = await t!.api('POST', `/api/tasks/${id}/release`, {});
    await t!.api('POST', `/api/approvals/${req.body.approval.id}/approve`, { confirmation: id });
    const r = await waitRelease(id, ['failed', 'live', 'refused', 'published_unconfirmed']);
    expect(r.state).toBe('failed');
    expect(r.reason).toContain('origin refused the push');
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(before.remote);
  }, 150_000);
});

describe('Proof of live', () => {
  it('Cloudflare Pages: live only when the project serves the pushed commit with a successful deploy; a failed build is a failure', async () => {
    const { remote, repositoryId } = await setup({ method: 'push', remote: 'origin', branch: 'main', liveUrl: 'https://live.test/', proof: { cloudflarePages: { project: 'shop' } }, manualPaths: [], timeoutSec: 60 });
    await t!.services.credentials.create({ name: 'pages-read', kind: 'cloudflare', envVar: null, description: 'test', repositoryIds: [repositoryId], value: ['cf', 'test', 'key'].join('-') });
    await t!.services.credentials.create({ name: 'cf-account', kind: 'other', envVar: 'CLOUDFLARE_ACCOUNT_ID', description: 'test', repositoryIds: [repositoryId], value: ACCOUNT });

    pages.mode = 'build-failed';
    const failedTask = await completedUnreleased(repositoryId);
    let req = await t!.api('POST', `/api/tasks/${failedTask}/release`, {});
    await t!.api('POST', `/api/approvals/${req.body.approval.id}/approve`, { confirmation: failedTask });
    let r = await waitRelease(failedTask, ['failed', 'live', 'refused', 'published_unconfirmed']);
    expect(r.state).toBe('failed');
    expect(r.reason).toContain('reported the build of');
    expect(r.evidence.cloudflarePages).toMatchObject({ ok: false, deploymentId: 'old-deployment', candidate: { deploymentId: 'failed-deployment', status: 'failure' } });
    expect(r.evidence.before).toMatchObject({ deploymentId: 'old-deployment' });
    const sent = t!.services.store.getTask(failedTask)!.git.commits.at(-1)!;
    // The commit reached the remote; the previous deployment stays live.
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(sent);

    pages.mode = 'serves-main';
    // A build retried on Cloudflare now serves the commit: Check again reads the proof only and confirms it.
    const pushes = events(failedTask).filter((e) => e.type === 'RELEASE_PUBLISHED').length;
    const check = await t!.api('POST', `/api/tasks/${failedTask}/release/check`, {});
    expect(check.status).toBe(202);
    r = await waitRelease(failedTask, ['live', 'failed', 'published_unconfirmed']);
    expect(r.state).toBe('live');
    expect(events(failedTask).filter((e) => e.type === 'RELEASE_PUBLISHED').length).toBe(pushes);

    // The next task starts from main as it now is: what Source Control's background sync does, done here by hand.
    await run(t!.services.store.getRepository(repositoryId)!.path, ['pull', '--ff-only']);
    const liveTask = await completedUnreleased(repositoryId);
    req = await t!.api('POST', `/api/tasks/${liveTask}/release`, {});
    await t!.api('POST', `/api/approvals/${req.body.approval.id}/approve`, { confirmation: liveTask });
    r = await waitRelease(liveTask, ['failed', 'live', 'refused', 'published_unconfirmed']);
    expect(r.state).toBe('live');
    expect(r.evidence.cloudflarePages).toMatchObject({ ok: true, deploymentId: 'new-deployment', stage: 'deploy', status: 'success' });
  }, 240_000);

  it('a provider it cannot read leaves the release Sent — not confirmed, and Check again only reads', async () => {
    const { remote, repositoryId } = await setup({ method: 'push', remote: 'origin', branch: 'main', liveUrl: 'https://live.test/', proof: { cloudflarePages: { project: 'shop' } }, manualPaths: [], timeoutSec: 60 });
    const id = await completedUnreleased(repositoryId);
    const req = await t!.api('POST', `/api/tasks/${id}/release`, {});
    await t!.api('POST', `/api/approvals/${req.body.approval.id}/approve`, { confirmation: id });
    const r = await waitRelease(id, ['failed', 'live', 'refused', 'published_unconfirmed']);
    expect(r.state).toBe('published_unconfirmed');
    expect(r.reason).toContain('Cloudflare could not be read');
    const sha = t!.services.store.getTask(id)!.git.commits.at(-1)!;
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(sha);

    // With a key the proof can be read: Check again confirms it, and pushes nothing.
    await t!.services.credentials.create({ name: 'pages-read', kind: 'cloudflare', envVar: null, description: 'test', repositoryIds: [repositoryId], value: ['cf', 'test', 'key'].join('-') });
    await t!.services.credentials.create({ name: 'cf-account', kind: 'other', envVar: 'CLOUDFLARE_ACCOUNT_ID', description: 'test', repositoryIds: [repositoryId], value: ACCOUNT });
    const pushesBefore = events(id).filter((e) => e.type === 'RELEASE_PUBLISHED').length;
    expect((await t!.api('POST', `/api/tasks/${id}/release/check`, {})).status).toBe(202);
    const live = await waitRelease(id, ['live', 'published_unconfirmed', 'failed']);
    expect(live.state).toBe('live');
    expect(events(id).filter((e) => e.type === 'RELEASE_PUBLISHED').length).toBe(pushesBefore);
  }, 150_000);

  it('a version URL counts only when it names the pushed commit', () => {
    const sha = '779bbcb0123456789abcdef0123456789abcdef0';
    expect(bodyNamesCommit('{"commit":"779bbcb"}', sha)).toBe(true);
    expect(bodyNamesCommit(`{"commit":"${sha}"}`, sha)).toBe(true);
    expect(bodyNamesCommit('{"commit":"779bbc"}', sha)).toBe(false);
    expect(bodyNamesCommit('{"commit":"1234567"}', sha)).toBe(false);
  });
});

describe('Restart and authority', () => {
  it('a release cut short by a restart is resolved from the remote and never pushed again', async () => {
    const { remote, repositoryId, before } = await setup();
    const id = await completedUnreleased(repositoryId);
    const task = t!.services.store.getTask(id)!;
    const sha = task.git.commits.at(-1)!;
    const base: TaskRelease = { state: 'publishing', commit: sha, tree: null, target: { remote: 'origin', branch: 'main', liveUrl: 'https://live.test/' }, via: 'button', approvalId: null, requestedAt: new Date().toISOString(), publishedAt: null, liveConfirmedAt: null, evidence: {}, reason: null };
    t!.services.store.updateTask(id, { git: { ...task.git, release: base } });
    expect(await t!.services.engine.release.recover()).toBe(1);
    expect(release(id)).toMatchObject({ state: 'failed' });
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(before.remote);

    // Sent before the restart: unconfirmed, not failed, and still not pushed again.
    await run(t!.services.store.getRepository(repositoryId)!.path, ['push', 'origin', `${sha}:refs/heads/main`]);
    t!.services.store.updateTask(id, { git: { ...t!.services.store.getTask(id)!.git, release: { ...base, state: 'proving', publishedAt: new Date().toISOString() } } });
    expect(await t!.services.engine.release.recover()).toBe(1);
    expect(release(id)).toMatchObject({ state: 'published_unconfirmed' });
    expect(release(id)!.reason).toContain('Use Check again');
  }, 150_000);

  it('the Chairman and chat cannot start a release, and a Chairman recovery never retries one', async () => {
    const { repositoryId } = await setup();
    const id = await fullTask(repositoryId);
    await waitFor(() => releaseApproval(id), (a) => a !== undefined, 90_000, 'the release approval');
    for (const type of ['RETURN_TO_STAGE', 'RETRY_STAGE'] as const) {
      const res = await t!.api('POST', `/api/tasks/${id}/chairman/actions`, { action: { type, params: { stageKey: 'release' } }, idempotencyKey: `k-${type}` });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('A release starts only from its approval or the Release button');
    }
    const wf = t!.services.store.getTask(id)!.workflow;
    const candidates = recoveryCandidates({ trigger: 'check_failed', workflow: wf, failingStageKey: 'release', signatureHash: 'sig', failureMessage: 'x', assignments: {}, availableAgents: ['codex', 'claude'], triedFingerprints: new Set(), rollbackCheckpointId: null });
    expect(candidates.some((c) => c.kind === 'retry_stage')).toBe(false);
  }, 120_000);

  it('routes answer only with the local token, refuse a task that is not completed, and Check setup sends nothing', async () => {
    const { remote, repositoryId, before } = await setup();
    const id = await fullTask(repositoryId);
    await waitFor(() => releaseApproval(id), (a) => a !== undefined, 90_000, 'the release approval');
    const noToken = await t!.app.inject({ method: 'POST', url: `/api/tasks/${id}/release`, headers: { host: '127.0.0.1:4317' } });
    expect(noToken.statusCode).toBe(401);
    const running = await t!.api('POST', `/api/tasks/${id}/release`, {});
    expect(running.status).toBe(409);
    expect(running.body.error.message).toContain('Only a completed task');

    const setupCheck = await t!.api('POST', `/api/repositories/${repositoryId}/release/check`, {});
    expect(setupCheck.status).toBe(200);
    expect(setupCheck.body.checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok])).toEqual([
      ['Remote', true],
      ['Branch', true],
      ['Live URL', true],
      ['Version URL', true],
    ]);
    // An unsaved form is checked as given.
    const draft = await t!.api('POST', `/api/repositories/${repositoryId}/release/check`, { release: { ...VERSION_PROOF, remote: 'upstream' } });
    expect(draft.body.ok).toBe(false);
    expect(draft.body.checks[0]).toMatchObject({ name: 'Remote', ok: false });
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(before.remote);
  }, 120_000);

  it('validates the release setting and the Release stage', async () => {
    t = await app();
    const repositoryId = await addRepo(t, await makeRepo());
    const bad = async (release: unknown) => (await t!.api('PATCH', `/api/repositories/${repositoryId}`, { release })).status;
    expect(await bad({ method: 'push', liveUrl: 'http://live.test/', proof: { versionUrl: 'https://live.test/v' } })).toBe(400);
    expect(await bad({ method: 'push', liveUrl: 'https://live.test/', proof: {} })).toBe(400);
    expect(await bad({ method: 'push', remote: '--force', liveUrl: 'https://live.test/', proof: { versionUrl: 'https://live.test/v' } })).toBe(400);
    expect(await bad({ method: 'push', branch: 'a..b', liveUrl: 'https://live.test/', proof: { versionUrl: 'https://live.test/v' } })).toBe(400);
    const ok = await t!.api('PATCH', `/api/repositories/${repositoryId}`, { release: { method: 'push', liveUrl: 'https://live.test/', proof: { versionUrl: 'https://live.test/v' } } });
    expect(ok.status).toBe(200);
    expect(ok.body.release).toMatchObject({ method: 'push', remote: 'origin', branch: 'main', manualPaths: [], timeoutSec: 900 });

    const stage = { key: 'release', name: 'Release', role: 'deployer', kind: 'release', optional: true, requiresApproval: true, permissionLevel: 5, next: 'complete' };
    const wf = (s: Record<string, unknown>) => validateWorkflow({ id: 'x', name: 'X', stages: [{ key: 'a', name: 'A', role: 'implementer', next: 'release' }, s] }).issues.map((i) => i.field);
    expect(wf(stage)).toEqual([]);
    expect(wf({ ...stage, permissionLevel: 4 })).toEqual(['permissionLevel']);
    expect(wf({ ...stage, requiresApproval: false })).toEqual(['requiresApproval']);
    expect(wf({ ...stage, onFail: 'a' })).toEqual(['onFail']);
  });
});
