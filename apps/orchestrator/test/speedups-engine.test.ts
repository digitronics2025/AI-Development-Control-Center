import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '@acc/git';
import type { StageDefinition } from '@acc/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSTALL_MARKER, INSTALLING_PROMPT_SECTION } from '../src/engine/tooling.js';
import type { ToolCallOutcome, ToolCallRequest } from '../src/tools/service.js';
import { addRepo, createTask, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from './helpers.js';

/**
 * Speed-ups measured on real tasks (TASK-0007..0019): the worktree install
 * runs beside read-only stages, the skills catalog is listed only for a
 * `/skill`, and a finished worktree is moved to the trash instead of being
 * deleted before COMPLETED.
 */

let t: TestApp | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await t?.close();
  t = null;
});

/** A Node repository with a lockfile (so its worktree gets an install) that ignores node_modules. */
function nodeRepo(): Promise<string> {
  return makeRepo({ files: { 'package-lock.json': '{ "lockfileVersion": 3, "packages": {} }\n', '.gitignore': 'node_modules/\n' } });
}

/**
 * Stand in for `node.install` (a real `npm ci` takes 29–55 s on the big
 * repository): it writes a partial node_modules, holds until `release()`
 * or until the call is stopped, then fills it with `files` files.
 */
function fakeInstall(app: TestApp, opts: { files?: number; hold?: boolean } = {}) {
  let release!: () => void;
  const held = opts.hold === false ? Promise.resolve() : new Promise<void>((r) => (release = r));
  const state = { calls: [] as string[], finished: 0, stopped: 0, worktreeThereAtEnd: [] as boolean[] };
  const invoke = app.services.tools.invoke.bind(app.services.tools);
  app.services.tools.invoke = async (req: ToolCallRequest): Promise<ToolCallOutcome> => {
    if (req.capability !== 'node.install') return invoke(req);
    const cwd = req.scope.cwd;
    state.calls.push(cwd);
    mkdirSync(path.join(cwd, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(path.join(cwd, 'node_modules', 'dep', 'partial.js'), '// half-installed\n');
    const stopped = await Promise.race([held.then(() => false), new Promise<boolean>((r) => req.signal?.addEventListener('abort', () => r(true), { once: true }))]);
    if (!stopped) {
      for (let i = 0; i < (opts.files ?? 1); i++) {
        const dir = path.join(cwd, 'node_modules', `pkg-${i % 50}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, `f${i}.js`), `module.exports = ${i};\n`);
      }
    }
    state[stopped ? 'stopped' : 'finished']++;
    state.worktreeThereAtEnd.push(existsSync(cwd));
    const result = stopped ? { ok: false, summary: 'npm ci stopped', error: { code: 'CANCELLED' as const, message: 'aborted' } } : { ok: true, summary: 'npm ci succeeded in 0.1s' };
    return { execution: { id: `fake-install-${state.calls.length}` }, result, decision: 'allow' } as unknown as ToolCallOutcome;
  };
  return { state, release: () => release?.() };
}

const stageKeys = (app: TestApp, id: string) => app.services.store.listStages(id).map((s) => s.stageKey);
const eventIndex = (app: TestApp, id: string, match: (e: { type: string; message: string }) => boolean) => app.services.store.listEvents(id, { limit: 2000 }).findIndex(match);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function promptText(app: TestApp, id: string, name: string): Promise<string> {
  const rec = app.services.store.listArtifacts(id).find((a) => a.name === name);
  if (!rec) throw new Error(`no artifact ${name}`);
  return (await app.services.artifacts.read(rec, 2_000_000)).content;
}

describe('item 3: the worktree install runs beside read-only stages', () => {
  it('starts Investigate before the install finishes, and Implement waits for it', async () => {
    t = await createTestApp();
    const install = fakeInstall(t);
    const id = await createTask(t, await addRepo(t, await nodeRepo()), 'Background install');
    // Investigate and Plan (Level 1) run and finish while the install is held.
    await waitFor(() => t!.services.store.listStages(id), (s) => s.some((x) => x.stageKey === 'plan' && x.status === 'SUCCESS'), 30_000, 'Plan to finish');
    expect(install.state.calls).toHaveLength(1);
    expect(install.state.finished).toBe(0);
    await pause(300);
    // Implement (Level 2) has not started: the loop waits for the install.
    expect(stageKeys(t, id)).toEqual(['investigate', 'plan']);
    expect(t.services.tooling.installRunning(id)).toBe(true);
    // A read-only stage that started beside the install is told node_modules may be incomplete.
    expect(await promptText(t, id, 'investigation-prompt.md')).toContain(INSTALLING_PROMPT_SECTION);

    install.release();
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.status).toBe('COMPLETED');
    const installed = eventIndex(t, id, (e) => e.type === 'TOOL_CALL' && e.message.startsWith('Installed dependencies in the worktree'));
    const investigateStarted = eventIndex(t, id, (e) => e.type === 'STAGE_STARTED' && e.message.startsWith('Investigate'));
    const implementStarted = eventIndex(t, id, (e) => e.type === 'STAGE_STARTED' && e.message.startsWith('Implement'));
    expect(investigateStarted).toBeGreaterThanOrEqual(0);
    expect(investigateStarted).toBeLessThan(installed);
    expect(installed).toBeLessThan(implementStarted);
    expect(await promptText(t, id, 'implementation-prompt.md')).not.toContain(INSTALLING_PROMPT_SECTION);
  }, 90_000);

  it('forgets what the tool layer found in the worktree once the install ends (a missing Wrangler may be there now)', async () => {
    t = await createTestApp();
    const install = fakeInstall(t);
    const forget = vi.spyOn(t.services.tools, 'forgetFolder');
    const id = await createTask(t, await addRepo(t, await nodeRepo()), 'Background install');
    await waitFor(() => install.state.calls.length, (n) => n === 1, 30_000, 'the install to start');
    expect(forget).not.toHaveBeenCalled();
    install.release();
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(forget).toHaveBeenCalledWith(install.state.calls[0]);
  }, 90_000);

  it('cancel during the install lets it end before the worktree is removed', async () => {
    t = await createTestApp();
    const install = fakeInstall(t);
    const id = await createTask(t, await addRepo(t, await nodeRepo()), 'Cancel me', { supervised: false });
    await waitFor(() => t!.services.store.listStages(id), (s) => s.some((x) => x.stageKey === 'plan' && x.status === 'SUCCESS'), 30_000, 'Plan to finish');
    const worktree = t.services.store.getTask(id)!.git.worktreePath!;
    expect(existsSync(worktree)).toBe(true);

    const cancelling = t.api('POST', `/api/tasks/${id}/cancel`);
    await pause(400);
    // Nothing is removed while the install still writes into the worktree.
    expect(t.services.store.getTask(id)!.status).not.toBe('CANCELLED');
    expect(existsSync(worktree)).toBe(true);
    install.release();
    expect((await cancelling).status).toBe(200);
    const cancelled = t.services.store.getTask(id)!;
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.git.worktreePath).toBeNull();
    expect(install.state.worktreeThereAtEnd).toEqual([true]);
    const installed = eventIndex(t, id, (e) => e.type === 'TOOL_CALL' && e.message.startsWith('Installed dependencies'));
    const removed = eventIndex(t, id, (e) => e.type === 'WORKTREE_REMOVED');
    expect(installed).toBeGreaterThanOrEqual(0);
    expect(installed).toBeLessThan(removed);
    expect(existsSync(worktree)).toBe(false);
    expect(stageKeys(t, id)).not.toContain('implement');
  }, 90_000);

  it('a task parked while its install runs reads as not running, and continues once both are done', async () => {
    t = await createTestApp();
    const install = fakeInstall(t);
    // Discuss First: the plan waits for your approval while the install is still held.
    const id = await createTask(t, await addRepo(t, await nodeRepo()), 'Parked early', { mode: 'discuss', supervised: false });
    const parked = await waitForStatus(t, id, ['WAITING_FOR_USER'], 30_000);
    expect(parked.blocker?.kind).toBe('approval');
    expect(t.services.tooling.installRunning(id)).toBe(true);
    // The loop let go of the stage and only waits for the install: no stage runs, nothing reads as running.
    expect(t.services.engine.isRunning(id)).toBe(false);
    expect(t.services.engine.runningStages().map((r) => r.taskId)).not.toContain(id);
    expect((await t.api('POST', `/api/approvals/${parked.blocker!.approvalId}/approve`, {})).status).toBe(200);
    await pause(300);
    expect(stageKeys(t, id)).toEqual(['investigate', 'plan']);
    install.release();
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED'], 60_000);
    expect(done.status).toBe('COMPLETED');
  }, 90_000);

  it('an install a shutdown cut short is done again when the task resumes', async () => {
    t = await createTestApp();
    const dataDir = t.dataDir;
    const first = fakeInstall(t);
    const id = await createTask(t, await addRepo(t, await nodeRepo()), 'Interrupted install', { supervised: false });
    await waitFor(() => t!.services.store.listStages(id), (s) => s.some((x) => x.stageKey === 'plan' && x.status === 'SUCCESS'), 30_000, 'Plan to finish');
    const worktree = t.services.store.getTask(id)!.git.worktreePath!;
    // The orchestrator stops mid-install: the install is stopped, node_modules is left half-filled and unmarked.
    await t.close();
    t = null;
    expect(first.state.stopped).toBe(1);
    expect(existsSync(path.join(worktree, 'node_modules', 'dep', 'partial.js'))).toBe(true);
    expect(existsSync(path.join(worktree, 'node_modules', INSTALL_MARKER))).toBe(false);

    t = await createTestApp({ dataDir });
    const second = fakeInstall(t, { hold: false });
    expect(t.services.store.getTask(id)!.status).toBe('INTERRUPTED');
    expect((await t.api('POST', `/api/tasks/${id}/resume`)).status).toBe(200);
    // Implement is the next stage, so it waits for the install that is done again.
    await waitFor(() => second.state.finished, (n) => n === 1, 30_000, 'the install to run again');
    await waitFor(() => existsSync(path.join(worktree, 'node_modules', INSTALL_MARKER)) || !existsSync(worktree), (v) => v, 30_000, 'the marker');
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.status).toBe('COMPLETED');
    expect(second.state.calls).toEqual([worktree]);
  }, 120_000);

  it('installs every repository of a task across repositories in the background', async () => {
    t = await createTestApp();
    const install = fakeInstall(t, { hold: false });
    const api = await addRepo(t, await nodeRepo());
    const web = await addRepo(t, await nodeRepo());
    const id = await createTask(t, api, 'Across two', { linkedRepositoryIds: [web], supervised: false });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(done.status).toBe('COMPLETED');
    expect(install.state.calls).toHaveLength(2);
    expect(new Set(install.state.calls.map((c) => path.dirname(c))).size).toBe(1);
  }, 120_000);

  it('trusts the marker, not node_modules: a half-filled folder is installed again, a marked one is not', async () => {
    t = await createTestApp();
    const install = fakeInstall(t, { hold: false });
    const repoId = await addRepo(t, await nodeRepo());
    const id = await createTask(t, repoId, 'Draft', { start: false });
    const dir = await nodeRepo();
    mkdirSync(path.join(dir, 'node_modules', 'half'), { recursive: true });
    const task = t.services.store.getTask(id)!;
    const repo = t.services.store.getRepository(repoId)!;
    await t.services.tooling.prepareWorktree(task, repo, dir);
    expect(install.state.calls).toEqual([dir]);
    expect(existsSync(path.join(dir, 'node_modules', INSTALL_MARKER))).toBe(true);
    await t.services.tooling.prepareWorktree(task, repo, dir);
    expect(install.state.calls).toHaveLength(1);
  }, 60_000);

  it("counts a later npm ci (a test stage's repair) as installed although it deleted the marker", async () => {
    t = await createTestApp();
    const install = fakeInstall(t, { hold: false });
    const repoId = await addRepo(t, await nodeRepo());
    const task = t.services.store.getTask(await createTask(t, repoId, 'Draft', { start: false }))!;
    const repo = t.services.store.getRepository(repoId)!;
    // An npm project whose one dependency is local, so a real `npm ci` needs no network.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-npm-'));
    mkdirSync(path.join(dir, 'local'));
    writeFileSync(path.join(dir, 'local', 'package.json'), JSON.stringify({ name: 'local', version: '1.0.0' }));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { local: 'file:./local' } }));
    const lock = { name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'app', version: '1.0.0', dependencies: { local: 'file:./local' } }, local: { version: '1.0.0' }, 'node_modules/local': { resolved: 'local', link: true } } };
    writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2));
    await t.services.tooling.prepareWorktree(task, repo, dir);
    expect(install.state.calls).toEqual([dir]);
    expect(existsSync(path.join(dir, 'node_modules', INSTALL_MARKER))).toBe(true);

    // The repair's locked install empties node_modules first: the marker goes, npm's own proof comes last.
    execSync('npm ci --offline --no-audit --no-fund', { cwd: dir, stdio: 'ignore', timeout: 60_000 });
    expect(existsSync(path.join(dir, 'node_modules', INSTALL_MARKER))).toBe(false);
    expect(existsSync(path.join(dir, 'node_modules', '.package-lock.json'))).toBe(true);
    await t.services.tooling.prepareWorktree(task, repo, dir);
    expect(install.state.calls).toHaveLength(1);

    // npm's file proves nothing about another package manager's install.
    const pnpmDir = mkdtempSync(path.join(os.tmpdir(), 'acc-pnpm-'));
    writeFileSync(path.join(pnpmDir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
    writeFileSync(path.join(pnpmDir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    mkdirSync(path.join(pnpmDir, 'node_modules'));
    writeFileSync(path.join(pnpmDir, 'node_modules', '.package-lock.json'), '{}');
    await t.services.tooling.prepareWorktree(task, repo, pnpmDir);
    expect(install.state.calls).toEqual([dir, pnpmDir]);
  }, 90_000);
});

describe('item 4: the skills catalog is listed only for a /skill', () => {
  const def = { key: 'investigate', name: 'Investigate', role: 'investigator', permissionLevel: 1 } as StageDefinition;
  const catalog = { agents: ['claude'], skills: [{ name: 'fix-bug', description: 'Fix a bug', source: 'user' as const, plugin: null }] };

  it('never lists skills for file paths, routes or URLs, and still does for /fix-bug in the task or a directive', async () => {
    t = await createTestApp();
    const list = vi.spyOn(t.services.skills, 'list').mockResolvedValue(catalog);
    const repoId = await addRepo(t, await makeRepo());
    const repo = t.services.store.getRepository(repoId)!;
    const paths = 'Fix apps/orchestrator/src/engine/engine.ts and packages/shared/src/skills.ts; the /api/tasks/:id route; see https://example.com/a/b and C:\\Users\\x\\y.ts';
    const pathsOnly = await createTask(t, repoId, paths, { start: false });
    list.mockClear();
    expect(await t.services.tooling.requestedSkillsSection(t.services.store.getTask(pathsOnly)!, def, repo)).toBe('');
    expect(list).not.toHaveBeenCalled();

    const named = await createTask(t, repoId, `${paths}\n\nUse /fix-bug.`, { start: false });
    list.mockClear();
    expect(await t.services.tooling.requestedSkillsSection(t.services.store.getTask(named)!, def, repo)).toContain('- `fix-bug` — Fix a bug');
    expect(list).toHaveBeenCalledTimes(1);

    const directed = await createTask(t, repoId, paths, { start: false });
    await t.services.engine.addDirective(directed, { text: 'Please run /fix-bug first' });
    list.mockClear();
    expect(await t.services.tooling.requestedSkillsSection(t.services.store.getTask(directed)!, def, repo)).toContain('`fix-bug`');
    expect(list).toHaveBeenCalledTimes(1);
  }, 60_000);
});

describe('item 5: a finished worktree goes to the trash, deleted after COMPLETED', () => {
  it('publishes COMPLETED while the moved folder still waits in the trash, then empties it', async () => {
    t = await createTestApp();
    fakeInstall(t, { hold: false, files: 3000 });
    const repoPath = await nodeRepo();
    const id = await createTask(t, await addRepo(t, repoPath), 'Completes fast', { workflowId: 'quick-change', supervised: false });
    const worktree = (await waitFor(() => t!.services.store.getTask(id)!.git.worktreePath, (p) => Boolean(p), 30_000, 'the worktree'))!;
    const trash = t.services.tooling.trashRoot();
    const seen: { worktreeThere: boolean; trash: string[]; at: number } = { worktreeThere: true, trash: [], at: 0 };
    const unsubscribe = t.services.bus.subscribe((m) => {
      if (m.type !== 'task' || m.task.id !== id || m.task.status !== 'COMPLETED' || seen.at) return;
      seen.worktreeThere = existsSync(worktree);
      seen.trash = existsSync(trash) ? readdirSync(trash) : [];
      seen.at = Date.now();
    });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    unsubscribe();
    expect(done.status).toBe('COMPLETED');
    // At COMPLETED the folder is already gone from its place and waits, whole, in the trash.
    expect(seen.worktreeThere).toBe(false);
    expect(seen.trash).toHaveLength(1);
    expect(existsSync(path.join(trash, seen.trash[0]!, 'node_modules', 'pkg-0'))).toBe(true);
    expect(done.git.worktreePath).toBeNull();
    // Git no longer lists it, the work is on the branch, and the patch was read from the branch.
    const listed = (await git(repoPath, ['worktree', 'list', '--porcelain'])).stdout;
    expect(listed).not.toContain(path.basename(worktree));
    expect(listed.split('\n').filter((l) => l.startsWith('worktree ')).length).toBe(1);
    expect((await git(repoPath, ['show', `${done.git.taskBranch}:sim-output.md`])).code).toBe(0);
    expect(await promptText(t, id, 'git-diff.patch')).toContain('sim-output.md');
    await waitFor(() => (existsSync(trash) ? readdirSync(trash).length : 0), (n) => n === 0, 60_000, 'the trash to be emptied');
    const deletedAfterMs = Date.now() - seen.at;
    expect(deletedAfterMs).toBeGreaterThanOrEqual(0);
    const removed = t.services.store.listEvents(id, { limit: 500 }).find((e) => e.type === 'WORKTREE_REMOVED');
    expect(removed?.message).toContain('Worktree removed');
  }, 120_000);

  it('falls back to removing the worktree in place when it cannot be moved to the trash', async () => {
    t = await createTestApp();
    // A file where the trash folder should be: the move fails, the old removal runs.
    writeFileSync(t.services.tooling.trashRoot(), 'not a folder');
    const repoPath = await makeRepo();
    const id = await createTask(t, await addRepo(t, repoPath), 'No trash', { workflowId: 'quick-change', supervised: false });
    const worktree = (await waitFor(() => t!.services.store.getTask(id)!.git.worktreePath, (p) => Boolean(p), 30_000, 'the worktree'))!;
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.git.worktreePath).toBeNull();
    expect(existsSync(worktree)).toBe(false);
    expect((await git(repoPath, ['worktree', 'list'])).stdout.trim().split('\n')).toHaveLength(1);
    expect(t.services.store.listEvents(id, { limit: 500 }).some((e) => e.type === 'WORKTREE_REMOVED' && e.message.includes('Worktree removed'))).toBe(true);
    expect(await t.services.tooling.emptyTrash()).toBe(0);
  }, 90_000);

  it('empties leftovers in the trash at start, without following links or touching anything else', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'acc-data-'));
    const trash = path.join(dataDir, 'trash');
    mkdirSync(path.join(trash, 'x-TASK-0001-abcd', 'node_modules', 'dep'), { recursive: true });
    writeFileSync(path.join(trash, 'x-TASK-0001-abcd', 'node_modules', 'dep', 'index.js'), '');
    // A link inside a leftover to a folder outside: removed as a link, its target kept.
    const outside = mkdtempSync(path.join(os.tmpdir(), 'acc-outside-'));
    writeFileSync(path.join(outside, 'keep.txt'), 'mine');
    symlinkSync(outside, path.join(trash, 'x-TASK-0001-abcd', 'node_modules', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    // A worktree still in use, outside the trash, is never touched.
    const inUse = path.join(dataDir, 'worktrees', 'repo-abc123', 'TASK-0002');
    mkdirSync(inUse, { recursive: true });
    writeFileSync(path.join(inUse, 'work.txt'), 'in progress');

    t = await createTestApp({ dataDir });
    await waitFor(() => readdirSync(trash).length, (n) => n === 0, 30_000, 'the startup sweep');
    expect(existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    expect(existsSync(path.join(inUse, 'work.txt'))).toBe(true);
  }, 60_000);

  it('neither empties nor moves into a trash folder that is itself a link', async () => {
    // `<data>/trash` is a junction to a folder outside: following it would delete that folder's contents.
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'acc-data-'));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'acc-outside-'));
    writeFileSync(path.join(outside, 'keep.txt'), 'mine');
    symlinkSync(outside, path.join(dataDir, 'trash'), process.platform === 'win32' ? 'junction' : 'dir');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    t = await createTestApp({ dataDir });
    // The startup sweep (or a later one) leaves the target alone.
    expect(await t.services.tooling.emptyTrash()).toBe(0);
    expect(readdirSync(outside)).toEqual(['keep.txt']);

    // A finished worktree is removed in place instead of being renamed into the link's target.
    const repoPath = await makeRepo();
    const id = await createTask(t, await addRepo(t, repoPath), 'Linked trash', { workflowId: 'quick-change', supervised: false });
    const worktree = (await waitFor(() => t!.services.store.getTask(id)!.git.worktreePath, (p) => Boolean(p), 30_000, 'the worktree'))!;
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.git.worktreePath).toBeNull();
    expect(existsSync(worktree)).toBe(false);
    expect((await git(repoPath, ['worktree', 'list'])).stdout.trim().split('\n')).toHaveLength(1);
    expect(await t.services.tooling.emptyTrash()).toBe(0);
    expect(readdirSync(outside)).toEqual(['keep.txt']);
    expect(warn.mock.calls.some(([m]) => String(m).includes('is not a plain folder'))).toBe(true);
  }, 90_000);
});
