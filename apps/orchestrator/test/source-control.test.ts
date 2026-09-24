import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import { git, headCommit } from '@acc/git';
import type { SourceControlSnapshot } from '@acc/shared';
import { migrate, openDatabase, schemaVersion } from '../src/db/database.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { reconcileGitOperations } from '../src/source-control/reconcile.js';
import { addRepo, createTask, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from './helpers.js';

let t: TestApp;
let counter = 0;
const key = () => `test-key-${Date.now()}-${counter++}`;

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

const base = (repoId: string) => `/api/repositories/${repoId}/source-control`;

async function snap(repoId: string): Promise<SourceControlSnapshot> {
  const res = await t.api('POST', `${base(repoId)}/refresh`);
  expect(res.status).toBe(200);
  return res.body;
}

async function post(repoId: string, action: string, body: Record<string, unknown>) {
  return t.api('POST', `${base(repoId)}/${action}`, { idempotencyKey: key(), ...body });
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

describe('Source Control snapshot', () => {
  it('matches Git: staged, unstaged, both, untracked, branch and version', async () => {
    const dir = await makeRepo();
    writeFileSync(path.join(dir, 'README.md'), '# Test repo\nstaged\n');
    await run(dir, ['add', 'README.md']);
    writeFileSync(path.join(dir, 'README.md'), '# Test repo\nstaged\nmore\n');
    writeFileSync(path.join(dir, 'new file.ts'), 'x\n');
    const repoId = await addRepo(t, dir);
    const s = await snap(repoId);
    expect(s.error).toBeNull();
    expect(s.branch).toMatchObject({ name: 'main', detached: false, unborn: false, upstream: null, relation: 'none' });
    expect(s.branch.head).toBe(await headCommit(dir));
    const readme = s.changes.find((c) => c.path === 'README.md')!;
    expect(readme).toMatchObject({ staged: true, unstaged: true, indexStatus: 'modified', worktreeStatus: 'modified', stagedStats: { additions: 1, deletions: 0 }, unstagedStats: { additions: 1, deletions: 0 } });
    expect(s.changes.find((c) => c.path === 'new file.ts')).toMatchObject({ untracked: true, staged: false });
    expect(s.totals).toEqual({ staged: 1, unstaged: 1, untracked: 1, conflicted: 0 });
    // Same state → same version.
    expect((await snap(repoId)).version).toBe(s.version);
  });

  it('reports not-a-repository and missing folders as states, not failures', async () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'acc-plain-'));
    const repoId = await addRepo(t, plain);
    const s = await snap(repoId);
    expect(s.error?.code).toBe('NOT_A_REPOSITORY');
    expect(s.isGitRepo).toBe(false);
    const stage = await post(repoId, 'stage', { expectedVersion: s.version, paths: ['a'] });
    expect(stage.status).toBe(409);
    expect(stage.body.error.code).toBe('NOT_A_REPOSITORY');
  });

  it('serves lazy per-file diffs only for changed paths and rejects traversal', async () => {
    const dir = await makeRepo();
    writeFileSync(path.join(dir, 'README.md'), '# Test repo\nchanged\n');
    const repoId = await addRepo(t, dir);
    const diff = await t.api('GET', `${base(repoId)}/diff?path=README.md&mode=unstaged`);
    expect(diff.status).toBe(200);
    expect(diff.body.diff).toContain('+changed');
    const staged = await t.api('GET', `${base(repoId)}/diff?path=README.md&mode=staged`);
    expect(staged.body.error.code).toBe('PATH_NOT_CHANGED');
    for (const bad of ['../outside.txt', '/etc/passwd', 'C:/Windows/win.ini', 'a/../../b']) {
      const res = await t.api('GET', `${base(repoId)}/diff?path=${encodeURIComponent(bad)}&mode=unstaged`);
      expect(res.status, bad).toBe(400);
    }
    // A syntactically valid but unchanged path is refused too: only changed paths are readable.
    expect((await t.api('GET', `${base(repoId)}/diff?path=package.json&mode=unstaged`)).body.error.code).toBe('PATH_NOT_CHANGED');
  });

  it('requires the local token like every other route', async () => {
    const repoId = await addRepo(t, await makeRepo());
    const res = await t.app.inject({ method: 'GET', url: base(repoId), headers: { host: '127.0.0.1:4317' } });
    expect(res.statusCode).toBe(401);
    expect((await t.api('GET', base('nope'))).status).toBe(404);
  });
});

describe('staging and committing', () => {
  it('edit → stage → staged diff → commit → history, with the journal and attribution', async () => {
    const dir = await makeRepo();
    const repoId = await addRepo(t, dir);
    writeFileSync(path.join(dir, 'feature.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(dir, 'README.md'), '# Test repo\nedit\n');
    let s = await snap(repoId);

    const staged = await post(repoId, 'stage', { expectedVersion: s.version, paths: ['feature.ts'] });
    expect(staged.status).toBe(200);
    expect(staged.body.operation).toMatchObject({ kind: 'stage', status: 'succeeded' });
    s = staged.body.snapshot;
    expect(s.changes.find((c) => c.path === 'feature.ts')).toMatchObject({ staged: true, indexStatus: 'added' });
    expect(s.changes.find((c) => c.path === 'README.md')).toMatchObject({ staged: false, unstaged: true });
    const stagedDiff = await t.api('GET', `${base(repoId)}/diff?path=feature.ts&mode=staged`);
    expect(stagedDiff.body.diff).toContain('+export const x = 1;');

    const commit = await post(repoId, 'commit', { expectedVersion: s.version, message: 'Add feature\n\nWith a body.' });
    expect(commit.status).toBe(200);
    const sha = commit.body.operation.commitSha;
    expect(sha).toBe(await headCommit(dir));
    expect(commit.body.snapshot.changes.map((c: { path: string }) => c.path)).toEqual(['README.md']);

    const history = await t.api('GET', `${base(repoId)}/history?limit=10`);
    expect(history.body.items[0]).toMatchObject({ sha, subject: 'Add feature', attribution: { kind: 'source-control' } });
    const details = await t.api('GET', `${base(repoId)}/commits/${sha}`);
    expect(details.body).toMatchObject({ body: 'Add feature\n\nWith a body.', files: [{ path: 'feature.ts', status: 'added', additions: 1 }] });
    const fileDiff = await t.api('GET', `${base(repoId)}/commits/${sha}/diff?path=feature.ts`);
    expect(fileDiff.body.diff).toContain('+export const x = 1;');

    const ops = await t.api('GET', `${base(repoId)}/operations`);
    expect(ops.body.map((o: { kind: string; status: string }) => `${o.kind}:${o.status}`)).toEqual(['commit:succeeded', 'stage:succeeded']);
    // The journal holds metadata only, never the diff or file contents.
    const row = t.services.db.prepare("SELECT * FROM git_operations WHERE kind = 'commit'").get() as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain('export const x');
  });

  it('unstages exactly the given file and supports Stage All / Unstage All', async () => {
    const dir = await makeRepo();
    const repoId = await addRepo(t, dir);
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    let s = await snap(repoId);
    const all = await post(repoId, 'stage', { expectedVersion: s.version, all: true });
    expect(all.status).toBe(200);
    s = all.body.snapshot;
    expect(s.totals.staged).toBe(2);
    const one = await post(repoId, 'unstage', { expectedVersion: s.version, paths: ['a.txt'] });
    expect(one.body.snapshot.changes.find((c: { path: string }) => c.path === 'a.txt')).toMatchObject({ staged: false, untracked: true });
    const none = await post(repoId, 'unstage', { expectedVersion: one.body.snapshot.version, all: true });
    expect(none.body.snapshot.totals.staged).toBe(0);
  });

  it('refuses a stale version when the relevant state changed, but not for unrelated edits', async () => {
    const dir = await makeRepo();
    const repoId = await addRepo(t, dir);
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    const s = await snap(repoId);
    // An unrelated file changes after the view was loaded: staging a.txt is still safe.
    writeFileSync(path.join(dir, 'b.txt'), 'b changed in the editor\n');
    await snap(repoId);
    const ok = await post(repoId, 'stage', { expectedVersion: s.version, paths: ['a.txt'] });
    expect(ok.status).toBe(200);
    // The file itself changes after the view was loaded: refused.
    const s2 = ok.body.snapshot as SourceControlSnapshot;
    writeFileSync(path.join(dir, 'b.txt'), 'b changed again, much longer than before\n');
    const stale = await post(repoId, 'stage', { expectedVersion: s2.version, paths: ['b.txt'] });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('GIT_STATE_CHANGED');
    // Refresh, then it works.
    const fresh = await snap(repoId);
    expect((await post(repoId, 'stage', { expectedVersion: fresh.version, paths: ['b.txt'] })).status).toBe(200);
    // An unknown version is refused outright.
    expect((await post(repoId, 'stage', { expectedVersion: 'never-seen', paths: ['b.txt'] })).body.error.code).toBe('GIT_STATE_CHANGED');
  });

  it('rejects paths Git does not report as changed', async () => {
    const dir = await makeRepo();
    const repoId = await addRepo(t, dir);
    const s = await snap(repoId);
    const res = await post(repoId, 'stage', { expectedVersion: s.version, paths: ['README.md'] });
    expect(res.body.error.code).toBe('PATH_NOT_CHANGED');
    expect((await post(repoId, 'stage', { expectedVersion: s.version, paths: ['../x'] })).status).toBe(400);
  });

  it('replays a duplicate request by idempotency key instead of acting twice', async () => {
    const dir = await makeRepo();
    const repoId = await addRepo(t, dir);
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    let s = await snap(repoId);
    await post(repoId, 'stage', { expectedVersion: s.version, paths: ['a.txt'] });
    s = await snap(repoId);
    const idempotencyKey = key();
    const first = await t.api('POST', `${base(repoId)}/commit`, { idempotencyKey, expectedVersion: s.version, message: 'Once' });
    expect(first.status).toBe(200);
    const head = await headCommit(dir);
    const again = await t.api('POST', `${base(repoId)}/commit`, { idempotencyKey, expectedVersion: s.version, message: 'Once' });
    expect(again.status).toBe(200);
    expect(again.body.operation.id).toBe(first.body.operation.id);
    expect(await headCommit(dir)).toBe(head);
    expect(JSON.parse(await run(dir, ['rev-list', '--count', 'HEAD']))).toBe(2);
  });

  it('keeps hooks enabled and reports a hook rejection with the staged state intact', async () => {
    const dir = await makeRepo();
    writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint: 2 problems" >&2\nexit 1\n');
    chmodSync(path.join(dir, '.git', 'hooks', 'pre-commit'), 0o755);
    const repoId = await addRepo(t, dir);
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    let s = await snap(repoId);
    s = (await post(repoId, 'stage', { expectedVersion: s.version, paths: ['a.txt'] })).body.snapshot;
    const res = await post(repoId, 'commit', { expectedVersion: s.version, message: 'Blocked' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HOOK_FAILED');
    expect(res.body.error.message).toContain('lint: 2 problems');
    expect((await snap(repoId)).totals.staged).toBe(1);
    const ops = (await t.api('GET', `${base(repoId)}/operations`)).body;
    expect(ops[0]).toMatchObject({ kind: 'commit', status: 'failed', errorCode: 'HOOK_FAILED' });
  });

  it('blocks committing sensitive files and credential-shaped content, and Stage All skips sensitive files', async () => {
    const dir = await makeRepo();
    const repoId = await addRepo(t, dir);
    writeFileSync(path.join(dir, '.env'), 'API_URL=http://localhost\n');
    writeFileSync(path.join(dir, 'ok.ts'), 'export {};\n');
    let s = await snap(repoId);
    expect(s.changes.find((c) => c.path === '.env')?.sensitive).toMatch(/environment file/);
    const all = await post(repoId, 'stage', { expectedVersion: s.version, all: true });
    expect(all.body.skipped).toEqual([expect.objectContaining({ path: '.env' })]);
    s = all.body.snapshot;
    expect(s.changes.find((c) => c.path === '.env')?.staged).toBe(false);
    // Staged explicitly, a sensitive file still blocks the commit.
    s = (await post(repoId, 'stage', { expectedVersion: s.version, paths: ['.env'] })).body.snapshot;
    const blocked = await post(repoId, 'commit', { expectedVersion: s.version, message: 'nope' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('SENSITIVE_CONTENT');
    expect(blocked.body.error.details.findings).toEqual([expect.objectContaining({ path: '.env' })]);
    // Content check: a provider token in an ordinary file (assembled at runtime).
    await post(repoId, 'unstage', { expectedVersion: (await snap(repoId)).version, paths: ['.env'] });
    writeFileSync(path.join(dir, 'config.ts'), `export const token = "${['gh', 'p_', 'B'.repeat(36)].join('')}";\n`);
    s = await snap(repoId);
    s = (await post(repoId, 'stage', { expectedVersion: s.version, paths: ['config.ts'] })).body.snapshot;
    const secret = await post(repoId, 'commit', { expectedVersion: s.version, message: 'nope' });
    expect(secret.body.error.code).toBe('SENSITIVE_CONTENT');
    expect(JSON.stringify(secret.body)).not.toContain('BBBBBBBB');
  });

  it('handles an unborn repository through the API', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-unborn-'));
    await run(dir, ['init', '-b', 'main']);
    for (const [k, v] of [['user.email', 'u@example.com'], ['user.name', 'U'], ['commit.gpgsign', 'false']]) await run(dir, ['config', k!, v!]);
    writeFileSync(path.join(dir, 'first.txt'), 'hi\n');
    const repoId = await addRepo(t, dir);
    let s = await snap(repoId);
    expect(s.branch).toMatchObject({ unborn: true, head: null, name: 'main' });
    expect((await t.api('GET', `${base(repoId)}/history`)).body.items).toEqual([]);
    s = (await post(repoId, 'stage', { expectedVersion: s.version, paths: ['first.txt'] })).body.snapshot;
    const commit = await post(repoId, 'commit', { expectedVersion: s.version, message: 'First' });
    expect(commit.status).toBe(200);
    expect(commit.body.snapshot.branch.unborn).toBe(false);
  });

  it('refuses to commit on a detached HEAD', async () => {
    const dir = await makeRepo();
    await run(dir, ['checkout', '--detach', 'HEAD']);
    const repoId = await addRepo(t, dir);
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    let s = await snap(repoId);
    expect(s.branch.detached).toBe(true);
    s = (await post(repoId, 'stage', { expectedVersion: s.version, paths: ['a.txt'] })).body.snapshot;
    expect((await post(repoId, 'commit', { expectedVersion: s.version, message: 'x' })).body.error.code).toBe('DETACHED_HEAD');
  });
});

describe('remote synchronization', () => {
  it('fetch → behind → sync fast-forwards; local commit → ahead → sync pushes; diverged → sync stops', async () => {
    const { local, other } = await repoWithRemote();
    const repoId = await addRepo(t, local);
    let s = await snap(repoId);
    expect(s.branch).toMatchObject({ upstream: 'origin/main', relation: 'synced' });

    await commitIn(other, 'remote.txt', 'r\n', 'remote change');
    await run(other, ['push']);
    const fetched = await post(repoId, 'fetch', {});
    expect(fetched.status).toBe(200);
    s = fetched.body.snapshot;
    expect(s.branch).toMatchObject({ relation: 'behind', behind: 1 });
    expect(s.lastFetch).toMatchObject({ ok: true });

    const ff = await post(repoId, 'sync', { expectedVersion: s.version });
    expect(ff.status).toBe(200);
    expect(ff.body.sync).toMatchObject({ outcome: 'fast-forwarded', behind: 1 });
    expect(ff.body.snapshot.branch.relation).toBe('synced');

    await commitIn(local, 'local.txt', 'l\n', 'local change');
    s = await snap(repoId);
    expect(s.branch).toMatchObject({ relation: 'ahead', ahead: 1 });
    const pushed = await post(repoId, 'sync', { expectedVersion: s.version });
    expect(pushed.body.sync).toMatchObject({ outcome: 'pushed', ahead: 1 });
    expect(pushed.body.snapshot.branch.relation).toBe('synced');

    await run(other, ['pull', '--ff-only']);
    await commitIn(other, 'o.txt', 'o\n', 'other');
    await run(other, ['push']);
    await commitIn(local, 'm.txt', 'm\n', 'mine');
    const headBefore = await headCommit(local);
    s = await snap(repoId);
    const diverged = await post(repoId, 'sync', { expectedVersion: s.version });
    expect(diverged.status).toBe(200);
    expect(diverged.body.sync).toMatchObject({ outcome: 'diverged', ahead: 1, behind: 1 });
    // No merge, no rebase: HEAD is exactly where it was.
    expect(await headCommit(local)).toBe(headBefore);
    expect(diverged.body.snapshot.branch.relation).toBe('diverged');
  });

  it('fetches but does not fast-forward over uncommitted tracked changes', async () => {
    const { local, other } = await repoWithRemote();
    const repoId = await addRepo(t, local);
    await commitIn(other, 'remote.txt', 'r\n', 'remote change');
    await run(other, ['push']);
    writeFileSync(path.join(local, 'README.md'), '# dirty\n');
    const head = await headCommit(local);
    const s = await snap(repoId);
    const res = await post(repoId, 'sync', { expectedVersion: s.version });
    expect(res.body.sync).toMatchObject({ outcome: 'behind-dirty', behind: 1 });
    expect(await headCommit(local)).toBe(head);
    expect(readFileSync(path.join(local, 'README.md'), 'utf8')).toBe('# dirty\n');
  });

  it('requires an explicit publish for a branch with no upstream, then syncs it', async () => {
    const { local } = await repoWithRemote();
    await run(local, ['switch', '-c', 'feature/one']);
    await commitIn(local, 'f.txt', 'f\n', 'feature');
    const repoId = await addRepo(t, local);
    let s = await snap(repoId);
    expect(s.branch).toMatchObject({ name: 'feature/one', upstream: null, relation: 'none' });
    expect((await post(repoId, 'sync', { expectedVersion: s.version })).body.error.code).toBe('NO_UPSTREAM');
    expect((await post(repoId, 'publish', { expectedVersion: s.version, remote: 'nowhere' })).body.error.code).toBe('UNKNOWN_REMOTE');
    const published = await post(repoId, 'publish', { expectedVersion: s.version, remote: 'origin' });
    expect(published.status).toBe(200);
    s = published.body.snapshot;
    expect(s.branch).toMatchObject({ upstream: 'origin/feature/one', relation: 'synced' });
  });

  it('refuses to push commits that contain secret material', async () => {
    const { local } = await repoWithRemote();
    const repoId = await addRepo(t, local);
    await commitIn(local, 'server.pem', 'not really a key\n', 'add pem');
    const s = await snap(repoId);
    const res = await post(repoId, 'sync', { expectedVersion: s.version });
    expect(res.body.error.code).toBe('SENSITIVE_CONTENT');
    expect((await snap(repoId)).branch.ahead).toBe(1);
  });

  it('reports a rejected push without forcing it', async () => {
    const { local, other } = await repoWithRemote();
    const repoId = await addRepo(t, local);
    await commitIn(local, 'l.txt', 'l\n', 'local');
    // The remote advances after our last fetch; sync fetches first, so it sees divergence rather than pushing blindly.
    await commitIn(other, 'o.txt', 'o\n', 'other');
    await run(other, ['push']);
    const s = await snap(repoId);
    const res = await post(repoId, 'sync', { expectedVersion: s.version });
    expect(res.body.sync.outcome).toBe('diverged');
    const remoteLog = await run(other, ['log', '--format=%s', '-n', '1', 'origin/main']);
    expect(remoteLog.trim()).toBe('other');
  });

  it('reports an unreachable remote as a failed fetch and keeps local state', async () => {
    const dir = await makeRepo();
    await run(dir, ['remote', 'add', 'origin', path.join(os.tmpdir(), 'acc-missing-remote', 'x.git')]);
    const repoId = await addRepo(t, dir);
    const res = await post(repoId, 'fetch', {});
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('NETWORK');
    expect((await snap(repoId)).lastFetch).toMatchObject({ ok: false });
  });
});

describe('coordination with tasks', () => {
  it('refuses Git mutations while a task stage is editing the repository, and allows reads', async () => {
    const dir = await makeRepo();
    const repoId = await addRepo(t, dir);
    writeFileSync(path.join(dir, 'mine.txt'), 'm\n');
    const s = await snap(repoId);
    const taskId = await createTask(t, repoId, 'Slow change [sim:slow]', { workflowId: 'quick-change' });
    await waitFor(() => t.services.coordinator.activeWriters(repoId), (w) => w.length > 0, 30_000, 'a writer');
    const view = await snap(repoId);
    expect(view.state.activeTask).toMatchObject({ id: taskId, writing: true });
    expect(view.state.mutationBlockedReason).toContain(taskId);
    const res = await post(repoId, 'stage', { expectedVersion: s.version, paths: ['mine.txt'] });
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('BLOCKED_BY_TASK');
    expect((await t.api('GET', `${base(repoId)}/history`)).status).toBe(200);
    await t.api('POST', `/api/tasks/${taskId}/cancel`);
    await waitForStatus(t, taskId, ['CANCELLED']);
    const after = await snap(repoId);
    expect(after.state.activeTask?.writing ?? false).toBe(false);
    // The task left its baseline: mine.txt is proven pre-existing work.
    expect(after.changes.find((c) => c.path === 'mine.txt')?.attribution).toBe('preexisting');
  });

  it('a writable stage waits for a Git mutation in flight', async () => {
    const coordinator = t.services.coordinator;
    const order: string[] = [];
    let finish!: () => void;
    const mutation = coordinator.runMutation('repo-x', 'stage', () => new Promise<void>((r) => (finish = r)).then(() => void order.push('mutation')));
    const writer = coordinator.acquireWriter('repo-x', 'TASK-1', 'Implement').then((release) => {
      order.push('writer');
      release();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([]);
    finish();
    await Promise.all([mutation, writer]);
    expect(order).toEqual(['mutation', 'writer']);
  });

  it('Stage All refuses mixed task/user files until the user confirms the exact list', async () => {
    const dir = await makeRepo({ dirty: { 'sim-output.md': 'user draft\n' } });
    const repoId = await addRepo(t, dir);
    const taskId = await createTask(t, repoId, 'Touch the draft', { workflowId: 'quick-change' });
    await waitForStatus(t, taskId, ['COMPLETED', 'FAILED']);
    const s = await snap(repoId);
    const file = s.changes.find((c) => c.path === 'sim-output.md')!;
    expect(file.attribution).toBe('both');
    const refused = await post(repoId, 'stage', { expectedVersion: s.version, all: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'MIXED_CHANGES_UNCONFIRMED', details: { paths: ['sim-output.md'] } });
    const ok = await post(repoId, 'stage', { expectedVersion: s.version, all: true, confirmMixed: ['sim-output.md'] });
    expect(ok.status).toBe(200);
  });
});

describe('AI assistance', () => {
  it('suggests a commit message from the staged diff without creating a task', async () => {
    const dir = await makeRepo();
    const repoId = await addRepo(t, dir);
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    let s = await snap(repoId);
    expect((await post(repoId, 'suggest-message', { expectedVersion: s.version })).body.error.code).toBe('NOTHING_STAGED');
    s = (await post(repoId, 'stage', { expectedVersion: s.version, paths: ['a.txt'] })).body.snapshot;
    const tasksBefore = (await t.api('GET', '/api/tasks')).body.items.length;
    const res = await post(repoId, 'suggest-message', { expectedVersion: s.version });
    expect(res.status).toBe(200);
    expect(res.body.subject).toBe('Simulated committer output.');
    expect((await t.api('GET', '/api/tasks')).body.items.length).toBe(tasksBefore);
  });

  it('reviews staged changes as a read-only task that runs beside a paused writer', async () => {
    const dir = await makeRepo();
    const repoId = await addRepo(t, dir);
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    writeFileSync(path.join(dir, '.env'), 'SECRET=abc\n');
    let s = await snap(repoId);
    s = (await post(repoId, 'stage', { expectedVersion: s.version, paths: ['a.txt', '.env'] })).body.snapshot;
    const res = await t.api('POST', `${base(repoId)}/review-staged`, { expectedVersion: s.version, purpose: 'Check before release' });
    expect(res.status).toBe(202);
    const task = await waitForStatus(t, res.body.taskId, ['COMPLETED', 'FAILED']);
    expect(task).toMatchObject({ status: 'COMPLETED', workflowId: 'staged-review' });
    expect(task.git.baselineSnapshotId).toBeNull();
    const patch = readFileSync(path.join(t.dataDir, 'tasks', task.id, 'staged.patch'), 'utf8');
    expect(patch).toContain('a.txt');
    expect(patch).not.toContain('SECRET');
    const latest = await t.api('GET', `${base(repoId)}/review`);
    expect(latest.body).toMatchObject({ task: { id: task.id }, verdict: 'PASS' });
    expect(latest.body.review).toContain('VERDICT: PASS');
    // Nothing in the repository changed.
    expect((await snap(repoId)).totals.staged).toBe(2);
  });
});

describe('recovery', () => {
  it('reconciles a commit that happened before the journal recorded it, without committing again', async () => {
    const dir = await makeRepo();
    const repoId = await addRepo(t, dir);
    const ops = t.services.gitOperations;
    const pre = await headCommit(dir);
    const { createHash } = await import('node:crypto');
    const op = ops.start({ id: 'op-commit', repositoryId: repoId, idempotencyKey: 'k-commit', kind: 'commit', startedAt: new Date().toISOString(), preHead: pre, preStateVersion: 'v' });
    ops.note(op.id, { messageHash: createHash('sha256').update('Lost response').digest('hex') });
    // Git committed, then the orchestrator "crashed" before finishing the journal.
    await commitIn(dir, 'x.txt', 'x\n', 'Lost response');
    const lost = t.services.gitOperations.start({ id: 'op-never', repositoryId: repoId, idempotencyKey: 'k-never', kind: 'commit', startedAt: new Date().toISOString(), preHead: await headCommit(dir), preStateVersion: 'v' });
    const report = await reconcileGitOperations({ operations: ops, repositories: t.services.repositories });
    expect(report.resolved).toEqual(expect.arrayContaining([{ id: 'op-commit', kind: 'commit', status: 'succeeded' }, { id: lost.id, kind: 'commit', status: 'failed' }]));
    expect(ops.get('op-commit')!.commitSha).toBe(await headCommit(dir));
    expect(JSON.parse(await run(dir, ['rev-list', '--count', 'HEAD']))).toBe(2);
  });

  it('confirms an interrupted push from the remote, and leaves it uncertain when the remote is unreachable', async () => {
    const { local } = await repoWithRemote();
    const repoId = await addRepo(t, local);
    await commitIn(local, 'p.txt', 'p\n', 'to push');
    const sha = (await headCommit(local))!;
    const ops = t.services.gitOperations;
    const pushed = ops.start({ id: 'op-push', repositoryId: repoId, idempotencyKey: 'k-push', kind: 'sync', startedAt: new Date().toISOString(), preHead: sha, preStateVersion: 'v', ref: 'origin/main' });
    ops.note(pushed.id, { pushedSha: sha });
    await run(local, ['push']); // the push itself went through before the crash
    const notPushed = ops.start({ id: 'op-push-2', repositoryId: repoId, idempotencyKey: 'k-push-2', kind: 'publish', startedAt: new Date().toISOString(), preHead: sha, preStateVersion: 'v', remote: 'origin', ref: 'refs/heads/nope' });
    ops.note(notPushed.id, { pushedSha: sha });
    await reconcileGitOperations({ operations: ops, repositories: t.services.repositories });
    expect(ops.get('op-push')!.status).toBe('succeeded');
    expect(ops.get('op-push-2')!.status).toBe('failed');

    const unreachable = ops.start({ id: 'op-push-3', repositoryId: repoId, idempotencyKey: 'k-push-3', kind: 'sync', startedAt: new Date().toISOString(), preHead: sha, preStateVersion: 'v', ref: 'origin/main' });
    ops.note(unreachable.id, { pushedSha: sha });
    await run(local, ['remote', 'set-url', 'origin', path.join(os.tmpdir(), 'acc-gone', 'r.git')]);
    await reconcileGitOperations({ operations: ops, repositories: t.services.repositories });
    expect(ops.get('op-push-3')!.status).toBe('uncertain');
  });

  it('upgrades an existing database in place with the journal migration', () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-db-')), 'old.db');
    const db = openDatabase(file);
    migrate(db, MIGRATIONS.filter((m) => m.version === 1));
    expect(schemaVersion(db)).toBe(1);
    migrate(db);
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(3);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'git_operations'").get()).toBeTruthy();
    db.close();
  });
});
