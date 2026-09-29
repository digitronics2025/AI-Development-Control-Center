import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { git } from '@acc/git';
import { releaseConfigSchema, type ReleaseConfigInput, type TaskRelease } from '@acc/shared';
import type { Probe } from '../src/release/service.js';
import { addRepo, createTask, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from './helpers.js';

/**
 * Direct Cloudflare releases (docs/plans/CLOUDFLARE_DIRECT_RELEASE_PLAN.md):
 * the tested commit is pushed, built in a clean copy and uploaded to a Pages
 * project through Wrangler. A stand-in Wrangler (committed in the fixture's
 * node_modules/.bin, which the tool prefers) and a stand-in Cloudflare API
 * share one state file, so what was "uploaded" is what the API then serves.
 */

async function run(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const stateDir = mkdtempSync(path.join(os.tmpdir(), 'acc-cf-state-'));
const STATE = path.join(stateDir, 'cloudflare.json');

interface Deployment {
  commit: string | null;
  branch: string;
  project: string;
  files: number;
  index: string;
}
interface CfState {
  project?: { name: string; productionBranch: string } | null;
  deployments?: Deployment[];
  failDeploy?: boolean;
}
const readState = (): CfState => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as CfState) : {});
const writeState = (s: CfState) => writeFileSync(STATE, JSON.stringify(s));

/** The stand-in Wrangler: `pages project create`, `pages deploy` and `whoami`, recording into the state file. */
const FAKE_WRANGLER = `const fs = require('fs');
const path = require('path');
const STATE = ${JSON.stringify(STATE)};
const read = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const s = read();
if (args[0] === 'whoami') { console.log('You are logged in with an User API Token.'); process.exit(0); }
if (args[0] === 'pages' && args[1] === 'project' && args[2] === 'create') {
  s.project = { name: args[3], productionBranch: flag('--production-branch') };
  fs.writeFileSync(STATE, JSON.stringify(s));
  console.log('Successfully created the project');
  process.exit(0);
}
if (args[0] === 'pages' && args[1] === 'deploy') {
  if (s.failDeploy) { console.error('A request to the Cloudflare API failed.'); process.exit(1); }
  const dir = args[2];
  const count = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
  const files = count(dir);
  s.deployments = [...(s.deployments || []), { commit: flag('--commit-hash') || null, branch: flag('--branch'), project: flag('--project-name'), files, index: fs.readFileSync(path.join(dir, 'index.html'), 'utf8') }];
  fs.writeFileSync(STATE, JSON.stringify(s));
  console.log('Success! Uploaded ' + files + ' files (0.50 sec)');
  console.log('Deployment complete! Take a peek over at https://abcd1234.shop-xyz.pages.dev');
  process.exit(0);
}
console.error('unexpected: ' + args.join(' '));
process.exit(2);
`;

/** Stand-in Cloudflare API: the project exists once created and serves its last upload. */
let cfServer: http.Server;
let cfBase = '';
beforeAll(async () => {
  cfServer = http.createServer((req, res) => {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const u = new URL(req.url!, 'http://x');
    const base = `/cf/accounts/${ACCOUNT}/pages/projects/shop`;
    const s = readState();
    const deps = (s.deployments ?? []).map((d, i) => ({ id: `deployment-${i + 1}`, url: `https://d${i + 1}.shop-xyz.pages.dev`, latest_stage: { name: 'deploy', status: 'success' }, deployment_trigger: { metadata: { commit_hash: d.commit, branch: d.branch } }, created_on: new Date().toISOString() }));
    if (!s.project) return json(404, { success: false, errors: [{ message: 'Project not found.' }] });
    if (u.pathname === base) return json(200, { success: true, result: { name: 'shop', subdomain: 'shop-xyz.pages.dev', production_branch: s.project.productionBranch, canonical_deployment: deps.at(-1) ?? null } });
    if (u.pathname === `${base}/deployments`) return json(200, { success: true, result: [...deps].reverse() });
    json(404, { success: false, errors: [{ message: 'not found' }] });
  });
  await new Promise<void>((resolve) => cfServer.listen(0, '127.0.0.1', resolve));
  cfBase = `http://127.0.0.1:${(cfServer.address() as AddressInfo).port}/cf`;
});
afterAll(() => {
  cfServer.close();
});

/** The live site answers once something was uploaded. */
const probe: Probe = async (url) => {
  if (!url.startsWith('https://shop-xyz.pages.dev')) return { status: null, body: '', error: 'unknown host' };
  const last = readState().deployments?.at(-1);
  return last ? { status: 200, body: last.index, error: null } : { status: null, body: '', error: 'no such host' };
};

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
  writeState({});
});

const DIRECT: ReleaseConfigInput = { method: 'cloudflare', remote: 'origin', branch: 'main', pages: { project: 'shop', outputDir: 'dist' }, manualPaths: ['db/migrations/**'], timeoutSec: 60 };

/**
 * A repository with a bare `origin`, a build that writes dist/index.html (ignored by Git, like a real build's
 * output) and the stand-in Wrangler committed where a project-local Wrangler lives.
 */
const BUILD = "const fs = require('fs');\nfs.mkdirSync('dist/assets', { recursive: true });\nfs.writeFileSync('dist/index.html', '<!doctype html><title>shop</title>');\nfs.writeFileSync('dist/assets/app.js', 'console.log(1)');\n";
/** A build that works only where the test script ran first: it reads a file the tests leave behind, which no commit holds. */
const LEFTOVER_BUILD = "if (!require('fs').existsSync('.cache/ok')) { console.error('missing .cache/ok'); process.exit(1); }\n" + BUILD;
const LEFTOVER_TEST = "node -e \"require('fs').mkdirSync('.cache',{recursive:true});require('fs').writeFileSync('.cache/ok','1');console.log('3 passed')\"";

async function releaseRepo(opts: { build?: string; test?: string } = {}): Promise<{ repo: string; remote: string }> {
  const repo = await makeRepo({ scripts: { test: opts.test ?? 'node -e "console.log(\'3 passed\')"', build: 'node build.js' } });
  writeFileSync(path.join(repo, 'build.js'), opts.build ?? BUILD);
  writeFileSync(path.join(repo, '.gitignore'), 'dist/\n.cache/\n');
  const bin = path.join(repo, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'fake-wrangler.cjs'), FAKE_WRANGLER);
  writeFileSync(path.join(bin, 'wrangler.cmd'), '@node "%~dp0fake-wrangler.cjs" %*\r\n');
  writeFileSync(path.join(bin, 'wrangler'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-wrangler.cjs" "$@"\n', { mode: 0o755 });
  await run(repo, ['add', '-A']);
  await run(repo, ['update-index', '--chmod=+x', 'node_modules/.bin/wrangler']);
  await run(repo, ['commit', '-m', 'app with a build']);
  const remote = path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-remote-')), 'origin.git');
  await run(os.tmpdir(), ['init', '--bare', '-b', 'main', remote]);
  await run(repo, ['remote', 'add', 'origin', remote]);
  await run(repo, ['push', '-u', 'origin', 'main']);
  return { repo, remote };
}

async function setup(release: ReleaseConfigInput = DIRECT, repoOptions: { build?: string; test?: string } = {}) {
  t = await createTestApp({ release: { probe, pollSeconds: 0.05 }, baseEnv: { ...process.env, ACC_CF_API_BASE: cfBase } });
  const { repo, remote } = await releaseRepo(repoOptions);
  const repositoryId = await addRepo(t, repo, { release });
  await t.services.credentials.create({ name: 'cf-deploy', kind: 'cloudflare', envVar: null, description: 'test', repositoryIds: [repositoryId], value: ['cf', 'test', 'key'].join('-') });
  await t.services.credentials.create({ name: 'cf-account', kind: 'other', envVar: 'CLOUDFLARE_ACCOUNT_ID', description: 'test', repositoryIds: [repositoryId], value: ACCOUNT });
  const before = { remote: await run(remote, ['rev-parse', 'refs/heads/main']), head: await run(repo, ['rev-parse', 'HEAD']), status: await run(repo, ['status', '--porcelain']) };
  return { repo, remote, repositoryId, before };
}

const releaseApproval = (taskId: string) => t!.services.store.listApprovals({ taskId }).filter((a) => a.status === 'pending').at(-1);
const release = (taskId: string): TaskRelease | null => t!.services.store.getTask(taskId)!.git.release ?? null;
const buildsLeft = () => {
  const root = path.join(t!.dataDir, 'releases');
  return existsSync(root) ? readdirSync(root).flatMap((d) => readdirSync(path.join(root, d))) : [];
};

async function waitRelease(taskId: string, states: TaskRelease['state'][], timeoutMs = 60_000): Promise<TaskRelease> {
  return waitFor(() => release(taskId), (r) => r !== null && states.includes(r.state), timeoutMs, `release of ${taskId} to reach ${states.join('/')}`) as Promise<TaskRelease>;
}

async function fullTask(repositoryId: string) {
  return createTask(t!, repositoryId, 'Add a feature', { workflowId: 'full-autopilot', supervised: false });
}

/** Run the task to its Release approval and approve it with the typed task id. */
async function approveRelease(taskId: string) {
  const approval = await waitFor(() => releaseApproval(taskId), (a) => a !== undefined, 120_000, 'the release approval').catch((error: unknown) => {
    const task = t!.services.store.getTask(taskId)!;
    const stages = t!.services.store.listStages(taskId).map((s) => `${s.stageKey}:${s.status}${s.summary ? ` (${s.summary.slice(0, 160)})` : ''}`);
    throw new Error(`${(error as Error).message}\ntask ${task.status} ${task.blocker?.message ?? ''}\n${stages.join('\n')}`);
  });
  expect((await t!.api('POST', `/api/approvals/${approval!.id}/approve`, { confirmation: taskId })).status).toBe(200);
  return approval!;
}

describe('setting', () => {
  it('accepts a Pages project and a folder inside the repository, nothing else', () => {
    const parse = (pages: Record<string, unknown>) => releaseConfigSchema.safeParse({ method: 'cloudflare', pages }).success;
    expect(releaseConfigSchema.parse({ method: 'cloudflare', pages: { project: 'shop' } })).toMatchObject({ remote: 'origin', branch: 'main', pages: { project: 'shop', outputDir: 'dist' }, timeoutSec: 600 });
    expect(parse({ project: 'shop', outputDir: 'apps/web/dist' })).toBe(true);
    for (const outputDir of ['../outside', '/abs', 'dist/../..', '.', '-rf', 'a b']) expect(parse({ project: 'shop', outputDir }), outputDir).toBe(false);
    for (const project of ['Shop', '-shop', 'shop;rm', 'a'.repeat(59)]) expect(parse({ project }), project).toBe(false);
  });
});

describe('direct Cloudflare release', () => {
  it('creates the project on the first release, uploads the tested commit built from a clean copy, and proves it live', async () => {
    const { repo, remote, repositoryId, before } = await setup();
    const id = await fullTask(repositoryId);
    const approval = await approveRelease(id);
    const sha = t!.services.store.getTask(id)!.git.commits.at(-1)!;
    expect(approval).toMatchObject({ kind: 'stage_permission', stageKey: 'release', permissionLevel: 5, environment: 'production' });
    expect(approval.action).toBe(`Deploy ${sha.slice(0, 7)} to Cloudflare Pages shop`);
    expect(approval.reason).toContain('build that exact commit in a clean copy, and upload dist to Cloudflare Pages shop (created on the first release)');

    const r = await waitRelease(id, ['live', 'failed', 'refused', 'published_unconfirmed']);
    expect(r.reason).toBeNull();
    expect(r.state).toBe('live');
    expect(r.target).toMatchObject({ method: 'cloudflare', project: 'shop', remote: 'origin', branch: 'main', liveUrl: 'https://shop-xyz.pages.dev/' });
    expect(r.evidence.deploy).toMatchObject({ project: 'shop', created: true, files: 2, url: 'https://abcd1234.shop-xyz.pages.dev' });
    expect(r.evidence.cloudflarePages).toMatchObject({ ok: true, commit: sha, stage: 'deploy', status: 'success' });
    expect(r.evidence.before).toBeNull();
    // Pushed as a fast-forward, created with main as production, uploaded once with the commit recorded.
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(sha);
    const state = readState();
    expect(state.project).toEqual({ name: 'shop', productionBranch: 'main' });
    expect(state.deployments).toEqual([expect.objectContaining({ commit: sha, branch: 'main', project: 'shop', files: 2, index: '<!doctype html><title>shop</title>' })]);
    // The build folder is gone, and the operator's folder was never touched.
    expect(buildsLeft()).toEqual([]);
    expect({ head: await run(repo, ['rev-parse', 'HEAD']), status: await run(repo, ['status', '--porcelain']) }).toEqual({ head: before.head, status: before.status });
    await waitForStatus(t!, id, ['COMPLETED'], 30_000);
    expect(t!.services.store.listStages(id).find((s) => s.stageKey === 'release')).toMatchObject({ status: 'SUCCESS' });
    const log = readFileSync(path.join(t!.dataDir, 'tasks', id, 'release.md'), 'utf8');
    expect(log).toContain('does not exist yet: this release creates it');
    expect(log).toContain('Upload to Cloudflare Pages shop (created by this release)');
  }, 240_000);

  it('sends and uploads nothing when the commit does not build from a clean copy', async () => {
    // The build passes in the task's folder, where the tests left a file behind, and fails where only the commit is.
    const { remote, repositoryId, before } = await setup(DIRECT, { build: LEFTOVER_BUILD, test: LEFTOVER_TEST });
    const id = await fullTask(repositoryId);
    await approveRelease(id);
    const r = await waitRelease(id, ['live', 'failed', 'refused', 'published_unconfirmed']);
    expect(r.state).toBe('refused');
    expect(r.reason).toContain('The build failed');
    expect(r.reason).toContain('missing .cache/ok');
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(before.remote);
    expect(readState()).toEqual({});
    expect(buildsLeft()).toEqual([]);
  }, 240_000);

  it('never replaces a live version the commit does not contain', async () => {
    writeState({ project: { name: 'shop', productionBranch: 'main' }, deployments: [{ commit: 'e'.repeat(40), branch: 'main', project: 'shop', files: 1, index: 'someone else' }] });
    const { remote, repositoryId, before } = await setup();
    const id = await fullTask(repositoryId);
    await approveRelease(id);
    const r = await waitRelease(id, ['live', 'failed', 'refused', 'published_unconfirmed']);
    expect(r.state).toBe('refused');
    expect(r.reason).toContain(`The live site serves ${'e'.repeat(7)}, which this commit does not contain`);
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(before.remote);
    expect(readState().deployments).toHaveLength(1);
    expect(buildsLeft()).toEqual([]);
  }, 240_000);

  it('an upload Cloudflare refuses after the push is a failure; the Release button retries only the upload', async () => {
    const { remote, repositoryId } = await setup();
    writeState({ failDeploy: true });
    const id = await fullTask(repositoryId);
    await approveRelease(id);
    const sha = t!.services.store.getTask(id)!.git.commits.at(-1)!;
    let r = await waitRelease(id, ['live', 'failed', 'refused', 'published_unconfirmed']);
    expect(r.state).toBe('failed');
    expect(r.reason).toContain('but Cloudflare did not take the upload');
    expect(r.evidence.deploy).toMatchObject({ project: 'shop', created: true });
    expect(await run(remote, ['rev-parse', 'refs/heads/main'])).toBe(sha);
    await waitForStatus(t!, id, ['COMPLETED'], 60_000);

    writeState({ ...readState(), failDeploy: false });
    const req = await t!.api('POST', `/api/tasks/${id}/release`, {});
    expect(req.body.approval).toBeTruthy();
    expect((await t!.api('POST', `/api/approvals/${req.body.approval.id}/approve`, { confirmation: id })).status).toBe(200);
    r = await waitRelease(id, ['live', 'failed', 'refused', 'published_unconfirmed']);
    expect(r.state).toBe('live');
    expect(r.evidence.deploy).toMatchObject({ created: false });
    expect(readState().deployments).toEqual([expect.objectContaining({ commit: sha })]);
    expect(buildsLeft()).toEqual([]);
  }, 300_000);

  it('Check setup reads everything and creates nothing', async () => {
    const { repositoryId } = await setup();
    const res = await t!.api('POST', `/api/repositories/${repositoryId}/release/check`, {});
    expect(res.status).toBe(200);
    const byName = Object.fromEntries((res.body.checks as Array<{ name: string; ok: boolean; detail: string }>).map((c) => [c.name, c]));
    expect(byName.Wrangler).toMatchObject({ ok: true });
    expect(byName['Cloudflare Pages']).toMatchObject({ ok: true, detail: 'shop does not exist yet: the first release creates it (production branch main)' });
    expect(byName.Build).toMatchObject({ ok: true, detail: expect.stringContaining('builds dist from a clean copy of the commit') });
    expect(byName['Live URL']).toBeUndefined();
    expect(res.body.ok).toBe(true);
    expect(readState()).toEqual({});
  }, 120_000);
});
