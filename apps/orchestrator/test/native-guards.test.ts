import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '@acc/git';
import { classifyCommand, referencesSelf, setSelfReferences } from '@acc/security';
import { defaultDataDir, defaultWorkDir, loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { INSTALL_MARKER } from '../src/engine/tooling.js';
import { Store } from '../src/store/store.js';
import { addRepo, createTask, createTestApp, makeRepo, ROOT, waitFor, type TestApp } from './helpers.js';

/**
 * SEC-3: agents' files live outside the data folder, so an agent can name
 * them while the data folder stays refused; worktrees made before move there
 * once; and Claude Code's native shell is prechecked by the Control Center.
 */

let t: TestApp | null = null;
afterEach(async () => {
  setSelfReferences({});
  await t?.close();
  t = null;
});

const sessionHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

describe('the work root (SEC-3 step 1)', () => {
  it('keeps worktree paths clear of the self-reference rules, while the secret files and the port stay refused', () => {
    const dataDir = defaultDataDir();
    const workDir = defaultWorkDir(dataDir);
    setSelfReferences({ dataDir, port: 4317 });
    const rel = path.relative(dataDir, workDir);
    expect(rel.startsWith('..')).toBe(true);
    const file = path.join(workDir, 'worktrees', 'shop-abc123', 'TASK-0001', 'src', 'index.ts');
    for (const spelling of [workDir, file, file.replace(/\\/g, '/'), `cat "${file}" && npm test`]) {
      expect(referencesSelf(spelling), spelling).toBe(false);
      expect(classifyCommand(`node "${spelling}"`).level, spelling).toBeLessThan(5);
    }
    for (const secret of ['auth-token', 'acc.db', 'acc.db-wal', 'credential-key.dpapi', 'privileged-key'].map((f) => path.join(dataDir, f))) {
      expect(referencesSelf(secret), secret).toBe(true);
      expect(referencesSelf(`cat "${secret.replace(/\\/g, '/')}"`), secret).toBe(true);
    }
    expect(referencesSelf('curl http://127.0.0.1:4317/')).toBe(true);
    expect(referencesSelf("node -e \"fetch('http://127.1:4317/')\"")).toBe(true);
  });

  it('gives any other data folder its own work root beside it, never inside or under its name', () => {
    const dataDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-root-')), 'data');
    const workDir = defaultWorkDir(dataDir);
    expect(path.dirname(workDir)).toBe(path.dirname(dataDir));
    expect(defaultWorkDir(dataDir)).toBe(workDir);
    expect(defaultWorkDir(`${dataDir}2`)).not.toBe(workDir);
    setSelfReferences({ dataDir, port: 4399 });
    expect(referencesSelf(path.join(workDir, 'worktrees', 'x', 'TASK-0001'))).toBe(false);
    expect(loadConfig({ ACC_DATA_DIR: dataDir, ACC_TOKEN_OVERRIDE: 'x'.repeat(40) }).workDir).toBe(workDir);
    const own = path.join(path.dirname(dataDir), 'work-here');
    expect(loadConfig({ ACC_DATA_DIR: dataDir, ACC_WORK_DIR: own, ACC_TOKEN_OVERRIDE: 'x'.repeat(40) }).workDir).toBe(own);
    expect(() => loadConfig({ ACC_DATA_DIR: dataDir, ACC_WORK_DIR: path.join(dataDir, 'work'), ACC_TOKEN_OVERRIDE: 'x'.repeat(40) })).toThrow(/outside the data folder/);
    expect(() => loadConfig({ ACC_DATA_DIR: dataDir, ACC_WORK_DIR: dataDir, ACC_TOKEN_OVERRIDE: 'x'.repeat(40) })).toThrow(/outside the data folder/);
  });

  it("never picks or accepts a work root whose path starts with the data folder's, which the self-reference rule would match", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'acc-prefix-'));
    for (const name of ['acc', 'a', 'ACC-', 'acc-work']) {
      const dataDir = path.join(parent, name);
      const workDir = defaultWorkDir(dataDir);
      expect(path.dirname(workDir), name).toBe(parent);
      setSelfReferences({ dataDir, port: 4399 });
      expect(referencesSelf(`node "${path.join(workDir, 'worktrees', 'shop-abc123', 'TASK-0001', 'package.json')}"`), `${name} → ${workDir}`).toBe(false);
      expect(referencesSelf(path.join(dataDir, 'acc.db')), name).toBe(true);
      expect(loadConfig({ ACC_DATA_DIR: dataDir, ACC_TOKEN_OVERRIDE: 'x'.repeat(40) }).workDir).toBe(workDir);
    }
    const dataDir = path.join(parent, 'acc');
    expect(() => loadConfig({ ACC_DATA_DIR: dataDir, ACC_WORK_DIR: `${dataDir}2`, ACC_TOKEN_OVERRIDE: 'x'.repeat(40) })).toThrow(/must not start with the data folder's path/);
    expect(() => loadConfig({ ACC_DATA_DIR: dataDir, ACC_WORK_DIR: path.join(parent, 'ACC-work'), ACC_TOKEN_OVERRIDE: 'x'.repeat(40) })).toThrow(/must not start with the data folder's path/);
  });

  it('creates task worktrees in the work root', async () => {
    t = await createTestApp();
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'Where [sim:hang]', { workflowId: 'quick-change', supervised: false });
    const worktree = (await waitFor(() => t!.services.store.getTask(id)!.git.worktreePath, (p) => Boolean(p), 30_000, 'the worktree'))!;
    expect(path.relative(path.join(t.workDir, 'worktrees'), worktree).startsWith('..')).toBe(false);
    expect(existsSync(path.join(t.dataDir, 'worktrees'))).toBe(false);
    await t.api('POST', `/api/tasks/${id}/cancel`);
  }, 60_000);
});

/** Stop the app, then put a task's folders back where they were before the work root existed, records included. */
async function makeLegacy(app: TestApp, taskId: string): Promise<{ dataDir: string; workDir: string }> {
  const { dataDir, workDir } = app;
  await app.close();
  const db = openDatabase(path.join(dataDir, 'acc.db'));
  try {
    const store = new Store(db);
    const task = store.getTask(taskId)!;
    const repoPath = store.getRepository(task.repositoryId)!.path;
    if (task.git.workspacePath) {
      const from = task.git.workspacePath;
      const to = path.join(dataDir, 'workspaces', path.basename(from));
      mkdirSync(path.dirname(to), { recursive: true });
      renameSync(from, to);
      const moved = (p: string) => path.join(to, path.relative(from, p));
      store.updateTask(taskId, { git: { ...task.git, workspacePath: to, worktreePath: moved(task.git.worktreePath!) } });
      expect((await git(repoPath, ['worktree', 'repair', moved(task.git.worktreePath!)])).code).toBe(0);
      for (const linked of store.listLinkedRepositories(taskId)) {
        store.updateLinkedRepositoryGit(taskId, linked.repositoryId, { ...linked.git, worktreePath: moved(linked.git.worktreePath!) });
        expect((await git(store.getRepository(linked.repositoryId)!.path, ['worktree', 'repair', moved(linked.git.worktreePath!)])).code).toBe(0);
      }
    } else {
      const from = task.git.worktreePath!;
      const to = path.join(dataDir, 'worktrees', path.relative(path.join(workDir, 'worktrees'), from));
      mkdirSync(path.dirname(to), { recursive: true });
      expect((await git(repoPath, ['worktree', 'move', from, to])).code).toBe(0);
      store.updateTask(taskId, { git: { ...task.git, worktreePath: to } });
    }
  } finally {
    db.close();
  }
  return { dataDir, workDir };
}

const listed = async (repoPath: string) =>
  (await git(repoPath, ['worktree', 'list', '--porcelain'])).stdout
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.resolve(l.slice(9)).toLowerCase());

describe('worktrees made in the data folder move to the work root once, at start', () => {
  it('moves a worktree with its uncommitted work, sets its installed dependencies aside, and does it once', async () => {
    t = await createTestApp();
    const repoPath = await makeRepo();
    const id = await createTask(t, await addRepo(t, repoPath), 'Legacy [sim:hang]', { workflowId: 'quick-change', supervised: false });
    await waitFor(() => t!.services.store.getTask(id)!.git.worktreePath, (p) => Boolean(p), 30_000, 'the worktree');
    const { dataDir, workDir } = await makeLegacy(t, id);
    t = null;
    const legacy = (await (async () => {
      const db = openDatabase(path.join(dataDir, 'acc.db'));
      try {
        return new Store(db).getTask(id)!.git.worktreePath!;
      } finally {
        db.close();
      }
    })())!;
    // Work the task had not committed, and an install the Control Center made (its marker).
    writeFileSync(path.join(legacy, 'uncommitted.txt'), 'keep me');
    mkdirSync(path.join(legacy, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(path.join(legacy, 'node_modules', INSTALL_MARKER), 'x');

    t = await createTestApp({ dataDir, workDir });
    const moved = t.services.store.getTask(id)!.git.worktreePath!;
    expect(moved).toBe(path.join(workDir, 'worktrees', path.relative(path.join(dataDir, 'worktrees'), legacy)));
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(path.join(moved, 'uncommitted.txt'))).toBe(true);
    expect(await listed(repoPath)).toContain(path.resolve(moved).toLowerCase());
    expect((await git(moved, ['status', '--porcelain'])).stdout).toContain('uncommitted.txt');
    // Its links would still name the old folder: set aside (to the trash, emptied in the background) for the next run to install again.
    expect(existsSync(path.join(moved, 'node_modules'))).toBe(false);
    // Once: nothing is left to move.
    expect(await t.services.tooling.relocateLegacyWorkFolders()).toEqual({ moved: [], kept: [] });
  }, 90_000);

  it('leaves a task whose worktree cannot move exactly where it was, and says why', async () => {
    t = await createTestApp();
    const repoPath = await makeRepo();
    const id = await createTask(t, await addRepo(t, repoPath), 'Stuck [sim:hang]', { workflowId: 'quick-change', supervised: false });
    const original = (await waitFor(() => t!.services.store.getTask(id)!.git.worktreePath, (p) => Boolean(p), 30_000, 'the worktree'))!;
    const { dataDir, workDir } = await makeLegacy(t, id);
    t = null;
    // Something already where it would go.
    mkdirSync(original, { recursive: true });
    writeFileSync(path.join(original, 'someone-elses.txt'), 'x');
    t = await createTestApp({ dataDir, workDir });
    const kept = t.services.store.getTask(id)!.git.worktreePath!;
    expect(kept.startsWith(path.join(dataDir, 'worktrees'))).toBe(true);
    expect(existsSync(path.join(kept, '.git'))).toBe(true);
    const again = await t.services.tooling.relocateLegacyWorkFolders();
    expect(again.moved).toEqual([]);
    expect(again.kept).toEqual([{ taskId: id, reason: expect.stringContaining('already exists') }]);
    // No agent works there: the run is refused before it starts, and the task waits for the operator saying why
    // (review, 2026-09-28: a folder in the data folder is a `..` from the Control Center's own files).
    const status = t.services.store.getTask(id)!.status;
    if (status !== 'RUNNING' && status !== 'WAITING_FOR_USER') expect((await t.api('POST', `/api/tasks/${id}/resume`)).status).toBe(200);
    const waiting = await waitFor(() => t!.services.store.getTask(id)!, (task) => task.status === 'WAITING_FOR_USER', 60_000, 'the refusal');
    expect(waiting.blocker?.message).toMatch(/still inside the Control Center's data folder/);
    expect(t.services.store.listExecutions(id).filter((e) => e.kind === 'agent' && e.cwd === kept)).toEqual([]);
  }, 120_000);

  it("moves a multi-repository task's workspace whole, and every repository's record of its worktree", async () => {
    t = await createTestApp();
    const apiPath = await makeRepo();
    const webPath = await makeRepo();
    const api = await addRepo(t, apiPath);
    const web = await addRepo(t, webPath);
    const id = await createTask(t, api, 'Both [sim:hang]', { linkedRepositoryIds: [web], workflowId: 'quick-change', supervised: false });
    await waitFor(() => t!.services.store.listEvents(id).filter((e) => e.type === 'GIT_BASELINE').length, (n) => n === 2, 30_000, 'both baselines');
    const { dataDir, workDir } = await makeLegacy(t, id);
    t = null;
    const legacy = path.join(dataDir, 'workspaces', id);
    writeFileSync(path.join(legacy, 'notes-at-the-root.md'), 'the agent left this');

    t = await createTestApp({ dataDir, workDir });
    const task = t.services.store.getTask(id)!;
    const linked = t.services.store.listLinkedRepositories(id)[0]!;
    expect(task.git.workspacePath).toBe(path.join(workDir, 'workspaces', id));
    expect(task.git.worktreePath).toBe(path.join(task.git.workspacePath!, task.git.folder!));
    expect(linked.git.worktreePath).toBe(path.join(task.git.workspacePath!, linked.folder));
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(path.join(task.git.workspacePath!, 'notes-at-the-root.md'))).toBe(true);
    expect(await listed(apiPath)).toContain(path.resolve(task.git.worktreePath!).toLowerCase());
    expect(await listed(webPath)).toContain(path.resolve(linked.git.worktreePath!).toLowerCase());
    expect((await git(linked.git.worktreePath!, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe(linked.git.taskBranch);
  }, 90_000);

  it('finishes a workspace move a stop cut off after the rename, before the repairs and records', async () => {
    t = await createTestApp();
    const apiPath = await makeRepo();
    const webPath = await makeRepo();
    const api = await addRepo(t, apiPath);
    const web = await addRepo(t, webPath);
    const id = await createTask(t, api, 'Halfway [sim:hang]', { linkedRepositoryIds: [web], workflowId: 'quick-change', supervised: false });
    await waitFor(() => t!.services.store.listEvents(id).filter((e) => e.type === 'GIT_BASELINE').length, (n) => n === 2, 30_000, 'both baselines');
    const { dataDir, workDir } = await makeLegacy(t, id);
    t = null;
    const legacy = path.join(dataDir, 'workspaces', id);
    const to = path.join(workDir, 'workspaces', id);
    writeFileSync(path.join(legacy, 'left-by-the-agent.md'), 'keep me');
    // The stop: the folder renamed; Git's records and the task's still name the old place.
    renameSync(legacy, to);

    t = await createTestApp({ dataDir, workDir });
    const task = t.services.store.getTask(id)!;
    const linked = t.services.store.listLinkedRepositories(id)[0]!;
    expect(task.git.workspacePath).toBe(to);
    expect(task.git.worktreePath).toBe(path.join(to, task.git.folder!));
    expect(linked.git.worktreePath).toBe(path.join(to, linked.folder));
    expect(existsSync(path.join(to, 'left-by-the-agent.md'))).toBe(true);
    expect(await listed(apiPath)).toContain(path.resolve(task.git.worktreePath!).toLowerCase());
    expect(await listed(webPath)).toContain(path.resolve(linked.git.worktreePath!).toLowerCase());
    expect(await t.services.tooling.relocateLegacyWorkFolders()).toEqual({ moved: [], kept: [] });
  }, 90_000);

  it("finishes a worktree move a stop cut off before the task's record", async () => {
    t = await createTestApp();
    const repoPath = await makeRepo();
    const id = await createTask(t, await addRepo(t, repoPath), 'Halfway [sim:hang]', { workflowId: 'quick-change', supervised: false });
    await waitFor(() => t!.services.store.getTask(id)!.git.worktreePath, (p) => Boolean(p), 30_000, 'the worktree');
    const { dataDir, workDir } = await makeLegacy(t, id);
    t = null;
    const db = openDatabase(path.join(dataDir, 'acc.db'));
    const legacy = new Store(db).getTask(id)!.git.worktreePath!;
    db.close();
    const to = path.join(workDir, 'worktrees', path.relative(path.join(dataDir, 'worktrees'), legacy));
    // The stop: Git moved it; the task's record still names the old place.
    expect((await git(repoPath, ['worktree', 'move', legacy, to])).code).toBe(0);

    t = await createTestApp({ dataDir, workDir });
    expect(t.services.store.getTask(id)!.git.worktreePath).toBe(to);
    expect(await t.services.tooling.relocateLegacyWorkFolders()).toEqual({ moved: [], kept: [] });
  }, 90_000);
});

describe('the native shell precheck (SEC-3 step 2)', () => {
  const PORT = 4399;

  /** A task whose first stage is running, and an agent session of that stage at Level 2. */
  async function runningStage() {
    t = await createTestApp();
    setSelfReferences({ dataDir: t.dataDir, port: PORT });
    const repoPath = await makeRepo();
    const repositoryId = await addRepo(t, repoPath);
    const taskId = await createTask(t, repositoryId, 'Guarded [sim:hang]', { workflowId: 'quick-change', supervised: false });
    const stage = (await waitFor(() => t!.services.store.listStages(taskId).find((s) => s.status === 'RUNNING'), (s) => Boolean(s), 30_000, 'a running stage'))!;
    const worktree = t.services.store.getTask(taskId)!.git.worktreePath!;
    const session = t.services.tools.openSession({ taskId, stageId: stage.id, repositoryId, cwd: worktree, roots: [worktree], stageLevel: 2, autoApproveUpToLevel: 3, mode: 'autopilot', profile: 'web-development', protectedPaths: [] }, 'agent');
    const ask = (command: string, token = session.token) => t!.api('POST', '/api/tool-session/precheck', { command }, sessionHeaders(token));
    const rows = () => t!.services.toolStore.listExecutions({ taskId, capability: 'native.bash', limit: 100 });
    return { taskId, stage, worktree, session, ask, rows };
  }

  it('answers only the live agent session of a running stage — never the local API token', async () => {
    const { taskId, ask, session, worktree } = await runningStage();
    expect((await ask('npm test')).body).toEqual({ decision: 'allow' });
    // The local token is not a session; neither is nothing.
    expect((await t!.api('POST', '/api/tool-session/precheck', { command: 'npm test' })).status).toBe(401);
    expect((await ask('npm test', 'not-a-session')).status).toBe(401);
    // An operator's session, or an agent's without a stage (Ask), is refused.
    const operator = t!.services.tools.openSession({ ...session.scope, stageId: null }, 'operator');
    expect((await ask('npm test', operator.token)).status).toBe(403);
    const stageless = t!.services.tools.openSession({ ...session.scope, stageId: null }, 'agent');
    expect((await ask('npm test', stageless.token)).status).toBe(403);
    // A stage that is no longer running, or a closed session, cannot ask either.
    const done = t!.services.tools.openSession({ ...session.scope, stageId: 'no-such-stage' }, 'agent');
    expect((await ask('npm test', done.token)).status).toBe(403);
    t!.services.tools.closeSession(session.id);
    expect((await ask('npm test')).status).toBe(401);
    expect(worktree).toBeTruthy();
    await t!.api('POST', `/api/tasks/${taskId}/cancel`);
  }, 60_000);

  it("refuses what names the Control Center or Claude's settings, and what the stage may not run, and records only refusals", async () => {
    const { taskId, stage, ask, rows, worktree } = await runningStage();
    const dataDir = t!.dataDir;
    const allowed = ['npm test', `node "${path.join(worktree, 'probe.test.mjs')}"`, `cat "${path.join(worktree, 'README.md').replace(/\\/g, '/')}"`, `ls ${worktree}`];
    for (const command of allowed) expect((await ask(command)).body, command).toEqual({ decision: 'allow' });
    expect(rows()).toEqual([]);

    const self = [`cat "${path.join(dataDir, 'auth-token')}"`, `cat ${path.join(dataDir, 'acc.db').replace(/\\/g, '/')}`, `curl -s http://127.0.0.1:${PORT}/`, `node -e "fetch('http://127.1:${PORT}/').then(r => r.text())"`, `curl "http://127.1":${PORT}/`];
    for (const command of self) {
      const res = (await ask(command)).body;
      expect(res.decision, command).toBe('deny');
      expect(res.reason).toMatch(/Reaches the Control Center's own token, data folder or API|Level 5/);
    }
    for (const command of ['echo {"disableAllHooks":true} > .claude/settings.local.json', 'cp x .claude\\settings.json']) {
      expect((await ask(command)).body.reason, command).toMatch(/Claude Code's settings files/);
    }
    // Above the stage's level: refused, with the way that can ask.
    const push = (await ask('git push origin HEAD')).body;
    expect(push.decision).toBe('deny');
    expect(push.reason).toMatch(/needs Level 3, and this stage is Level 2/);
    expect(push.reason).toMatch(/shell\.run/);

    const recorded = rows();
    expect(recorded).toHaveLength(self.length + 3);
    expect(recorded.every((r) => r.status === 'denied' && r.decision === 'deny' && r.origin === 'agent' && r.stageId === stage.id && r.errorCode === 'DENIED')).toBe(true);
    expect(recorded.some((r) => r.inputSummary.includes(`127.1:${PORT}`))).toBe(true);
    await t!.api('POST', `/api/tasks/${taskId}/cancel`);
  }, 60_000);

  it('refuses every path into the data folder, a task folder left there included: no agent works there', async () => {
    const { taskId, session } = await runningStage();
    // A worktree the move at start could not relocate: it still lives in the data folder. Its runs are refused before
    // they start (runners.launchAgent), and the checks read a call as written, so naming it is refused too (review,
    // 2026-09-28: writing it relative let a climb out of it hide the data folder's name).
    const legacy = path.join(t!.dataDir, 'worktrees', 'app', 'TASK-LEGACY');
    mkdirSync(legacy, { recursive: true });
    const token = t!.services.tools.openSession({ ...session.scope, cwd: legacy, roots: [legacy] }, 'agent').token;
    const shell = async (command: string) => (await t!.api('POST', '/api/tool-session/precheck', { command }, sessionHeaders(token))).body;
    const read = async (file: string) => (await t!.api('POST', '/api/tool-session/precheck', { tool: 'Read', input: { file_path: file } }, sessionHeaders(token))).body;
    for (const command of [`ls ${legacy}`, `cat "${path.join(legacy, 'README.md')}"`, `node "${path.join(legacy, 'probe.test.mjs').replace(/\\/g, '/')}"`]) {
      expect((await shell(command)).decision, command).toBe('deny');
    }
    expect((await read(path.join(legacy, 'src', 'a.ts'))).decision).toBe('deny');
    for (const command of [`cat "${path.join(legacy, '..', '..', '..', 'auth-token')}"`, `ls ${path.join(t!.dataDir, 'worktrees', 'app', 'TASK-OTHER')}`, `cat "${path.join(t!.dataDir, 'auth-token')}"`]) {
      expect((await shell(command)).decision, command).toBe('deny');
    }
    expect((await read(path.join(legacy, '..', '..', '..', 'auth-token'))).decision).toBe('deny');
    expect((await read(path.join(t!.dataDir, 'auth-token'))).decision).toBe('deny');
    await t!.api('POST', `/api/tasks/${taskId}/cancel`);
  }, 60_000);

  it("runs the approved stage's own level above the task's auto-approve ceiling, and nothing above the stage", async () => {
    const { taskId, session, worktree, rows } = await runningStage();
    const open = (over: Partial<typeof session.scope>) => t!.services.tools.openSession({ ...session.scope, ...over }, 'agent').token;
    // A Level 2 stage the operator approved in a task that auto-approves Level 1.
    const approvedL2 = open({ stageLevel: 2, autoApproveUpToLevel: 1, mode: 'autopilot' });
    for (const command of ['npm test', 'npm install', 'pnpm build', `node "${path.join(worktree, 'probe.test.mjs')}"`, 'mkdir out']) {
      expect((await t!.api('POST', '/api/tool-session/precheck', { command }, sessionHeaders(approvedL2))).body, command).toEqual({ decision: 'allow' });
    }
    expect((await t!.api('POST', '/api/tool-session/precheck', { command: 'git push origin acc/topic' }, sessionHeaders(approvedL2))).body.reason).toMatch(/needs Level 3, and this stage is Level 2/);
    // A Level 3 (Git) stage approved in Safe mode, whose own ceiling is Level 2.
    const approvedL3 = open({ stageLevel: 3, autoApproveUpToLevel: 3, mode: 'safe' });
    for (const command of ['git push origin acc/topic', 'git push']) {
      expect((await t!.api('POST', '/api/tool-session/precheck', { command }, sessionHeaders(approvedL3))).body, command).toEqual({ decision: 'allow' });
    }
    expect(rows()).toHaveLength(1);
    // A production branch and the Control Center itself stay refused.
    expect((await t!.api('POST', '/api/tool-session/precheck', { command: 'git push origin main' }, sessionHeaders(approvedL3))).body.decision).toBe('deny');
    expect((await t!.api('POST', '/api/tool-session/precheck', { command: `cat "${path.join(t!.dataDir, 'auth-token')}"` }, sessionHeaders(approvedL3))).body.decision).toBe('deny');
    await t!.api('POST', `/api/tasks/${taskId}/cancel`);
  }, 60_000);

  it("refuses what would change the shell check's own script or folder, and lets them be read", async () => {
    const { taskId, ask, rows, worktree } = await runningStage();
    const script = path.join(ROOT, 'apps', 'orchestrator', 'dist', 'acc-shell-guard.mjs');
    const dist = path.dirname(script);
    const slash = (p: string) => p.replace(/\\/g, '/');
    const gitBash = (p: string) => slash(p).replace(/^([A-Za-z]):/, (_m, drive: string) => `/${drive.toLowerCase()}`);
    const changes = [
      `node -e "require('fs').writeFileSync('${slash(script)}','process.exit(0)')"`,
      `echo "process.exit(0)" > "${script}"`,
      `cp ${slash(path.join(worktree, 'README.md'))} ${slash(script)}`,
      `rm ${gitBash(script)}`,
      `mv "${dist}" "${dist}.old"`,
      `echo '{"type":"commonjs"}' > ${gitBash(path.join(dist, 'package.json'))}`,
      'cd ../../somewhere && cp x.js ACC-SHELL-GUARD.mjs',
    ];
    for (const command of changes) {
      const res = (await ask(command)).body;
      expect(res.decision, command).toBe('deny');
      expect(res.reason, command).toMatch(/Changes the Control Center's check of shell commands/);
    }
    expect(rows()).toHaveLength(changes.length);
    for (const command of [`cat "${script}"`, `ls ${gitBash(dist)}`, 'grep -rn acc-shell-guard .']) expect((await ask(command)).body, command).toEqual({ decision: 'allow' });
    await t!.api('POST', `/api/tasks/${taskId}/cancel`);
  }, 60_000);

  it('lets the learned plugins be read, and nothing more', async () => {
    const { taskId, ask } = await runningStage();
    const plugins = path.join(t!.dataDir, 'learning', 'plugins');
    const skill = path.join(plugins, 'global', 'skills', 'fix', 'SKILL.md');
    expect((await ask(`cat "${skill}"`)).body).toEqual({ decision: 'allow' });
    expect((await ask(`cat ${skill.replace(/\\/g, '/')}`)).body).toEqual({ decision: 'allow' });
    const up = [plugins, '..', '..', 'acc.db'].join(path.sep);
    for (const command of [`node "${path.join(plugins, 'global', 'run.js')}"`, `echo x > "${skill}"`, `cat "${up}"`, `cat ${up.replace(/\\/g, '/')}`, `cat "${skill}" "${path.join(t!.dataDir, 'acc.db')}"`]) {
      expect((await ask(command)).body.decision, command).toBe('deny');
    }
    await t!.api('POST', `/api/tasks/${taskId}/cancel`);
  }, 60_000);

  it("judges Claude's native file reads by the paths they read: the Control Center's files refused and recorded, the rest read", async () => {
    const { taskId, stage, worktree, session } = await runningStage();
    const dataDir = t!.dataDir;
    const slash = (p: string) => p.replace(/\\/g, '/');
    type FileTool = 'Read' | 'Grep' | 'Glob';
    const ask = (tool: FileTool, input: Record<string, unknown>, cwd = worktree) => t!.api('POST', '/api/tool-session/precheck', { tool, input, cwd }, sessionHeaders(session.token));
    const rows = (capability: string) => t!.services.toolStore.listExecutions({ taskId, capability, limit: 100 });
    const plugins = path.join(dataDir, 'learning', 'plugins');
    const skill = path.join(plugins, 'global', 'skills', 'fix', 'SKILL.md');
    const allowed: Array<[FileTool, Record<string, unknown>]> = [
      ['Read', { file_path: path.join(worktree, 'README.md') }],
      ['Read', { file_path: slash(path.join(worktree, 'README.md')), offset: 1, limit: 20 }],
      // The learned plugins, and this task's own attachments (the prompt names them by path), live in the data folder and may be read.
      ['Read', { file_path: skill }],
      ['Read', { file_path: path.join(dataDir, 'tasks', taskId, 'attachments', 'screen.png') }],
      // Grep's pattern is text to find, not a path: the repository may be searched for the word.
      ['Grep', { pattern: 'auth-token', path: worktree, output_mode: 'content' }],
      ['Grep', { pattern: 'TODO' }],
      ['Grep', { pattern: 'name:', path: plugins, glob: '**/SKILL.md' }],
      ['Glob', { pattern: '**/*.md' }],
      ['Glob', { pattern: 'src/**/*.ts', path: worktree }],
      ['Glob', { pattern: '**/SKILL.md', path: slash(plugins) }],
    ];
    for (const [tool, input] of allowed) expect((await ask(tool, input)).body, `${tool} ${JSON.stringify(input)}`).toEqual({ decision: 'allow' });
    for (const capability of ['native.read', 'native.grep', 'native.glob']) expect(rows(capability), capability).toEqual([]);

    const own: Array<[FileTool, Record<string, unknown>]> = [
      ['Read', { file_path: path.join(dataDir, 'auth-token') }],
      ['Read', { file_path: slash(path.join(dataDir, 'acc.db')) }],
      ['Read', { file_path: [plugins, '..', '..', 'credential-key.dpapi'].join(path.sep) }],
      // Relative: resolved against the run's folder.
      ['Read', { file_path: path.relative(worktree, path.join(dataDir, 'acc.db-wal')) }],
      // Another task's files.
      ['Read', { file_path: path.join(dataDir, 'tasks', 'TASK-9999', 'attachments', 'x.png') }],
      ['Grep', { pattern: '.', path: dataDir }],
      // A glob read inside the searched folder, out of the learned plugins.
      ['Grep', { pattern: '.', path: plugins, glob: '../../*.db' }],
      ['Glob', { pattern: '*', path: slash(dataDir) }],
      ['Glob', { pattern: `${slash(dataDir)}/*.db*` }],
    ];
    for (const [tool, input] of own) {
      const res = (await ask(tool, input)).body;
      expect(res.decision, `${tool} ${JSON.stringify(input)}`).toBe('deny');
      expect(res.reason, `${tool} ${JSON.stringify(input)}`).toMatch(/^Reads the Control Center's own data folder, token or key files\. Agents cannot do this/);
    }
    // A search of a folder above the data folder would read every file in it — also from the CLI's own folder, which the hook reports.
    expect((await ask('Grep', { pattern: '.', path: path.dirname(dataDir) })).body.reason).toMatch(/^Searches a folder that holds the Control Center's own data folder/);
    expect((await ask('Glob', { pattern: '**/*' }, path.dirname(dataDir))).body.decision).toBe('deny');

    const recorded = { read: rows('native.read'), grep: rows('native.grep'), glob: rows('native.glob') };
    expect([recorded.read.length, recorded.grep.length, recorded.glob.length]).toEqual([5, 3, 3]);
    const all = [...recorded.read, ...recorded.grep, ...recorded.glob];
    expect(all.every((r) => r.status === 'denied' && r.decision === 'deny' && r.origin === 'agent' && r.stageId === stage.id && r.errorCode === 'DENIED' && r.permissionLevel === 5)).toBe(true);
    expect(recorded.read.some((r) => r.inputSummary.includes('auth-token') && r.inputSummary.includes('file_path'))).toBe(true);
    expect(rows('native.bash')).toEqual([]);
    // A body that is neither a command nor a guarded file tool's call is not a decision.
    expect((await t!.api('POST', '/api/tool-session/precheck', { tool: 'Edit', input: { file_path: 'x' } }, sessionHeaders(session.token))).status).toBeGreaterThanOrEqual(400);
    await t!.api('POST', `/api/tasks/${taskId}/cancel`);
  }, 60_000);

  it('end to end: the hook process asks this orchestrator and exits 2 with its reason, or 0', async () => {
    const { taskId, worktree, session, rows } = await runningStage();
    await t!.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (t!.app.server.address() as AddressInfo).port;
    const hook = (command: string | { tool: string; input: Record<string, unknown> }, url = `http://127.0.0.1:${port}`) =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'packages', 'agent-claude', 'src', 'shell-guard-hook.ts')], { cwd: ROOT, env: { ...process.env, ACC_TOOL_URL: url, ACC_TOOL_SESSION: session.token }, windowsHide: true });
        let stderr = '';
        child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
        child.on('close', (code) => resolve({ code, stderr }));
        const call = typeof command === 'string' ? { tool_name: 'Bash', tool_input: { command } } : { tool_name: command.tool, tool_input: command.input };
        child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', ...call, cwd: worktree }));
      });
    expect(await hook(`node "${path.join(worktree, 'probe.test.mjs').replace(/\\/g, '/')}"`)).toEqual({ code: 0, stderr: '' });
    const denied = await hook(`cat "${path.join(t!.dataDir, 'auth-token')}"`);
    expect(denied.code).toBe(2);
    expect(denied.stderr).toMatch(/^Refused by the AI Development Control Center: Reaches the Control Center's own token/);
    expect(rows()).toHaveLength(1);
    // Claude's Read goes through the same hook.
    expect(await hook({ tool: 'Read', input: { file_path: path.join(worktree, 'README.md') } })).toEqual({ code: 0, stderr: '' });
    const read = await hook({ tool: 'Read', input: { file_path: path.join(t!.dataDir, 'auth-token') } });
    expect(read.code).toBe(2);
    expect(read.stderr).toMatch(/^Refused by the AI Development Control Center: Reads the Control Center's own data folder, token or key files/);
    expect(t!.services.toolStore.listExecutions({ taskId, capability: 'native.read', limit: 10 })).toHaveLength(1);
    // The orchestrator gone: refused all the same, a file read too.
    const gone = await hook('npm test', 'http://127.0.0.1:1');
    expect(gone.code).toBe(2);
    expect(gone.stderr).toMatch(/could not be reached/);
    const goneRead = await hook({ tool: 'Read', input: { file_path: path.join(worktree, 'README.md') } }, 'http://127.0.0.1:1');
    expect(goneRead.code).toBe(2);
    expect(goneRead.stderr).toMatch(/could not be reached/);
    await t!.api('POST', `/api/tasks/${taskId}/cancel`);
  }, 90_000);

  it('opens a guard-only session when tools are off for agents: the shell stays, no tool route opens', async () => {
    const { taskId, stage } = await runningStage();
    const tooling = t!.services.tooling as unknown as { d: { shellGuardPath: string | null; bridgePath: string | null } };
    tooling.d.shellGuardPath = path.join(t!.dataDir, 'stand-in-guard.js');
    tooling.d.bridgePath = path.join(t!.dataDir, 'stand-in-bridge.js');
    t!.services.tooling.setListenUrl('http://127.0.0.1:1');
    const task = t!.services.store.getTask(taskId)!;
    const repo = t!.services.store.getRepository(task.repositoryId)!;
    const def = task.workflow.stages.find((s) => s.key === stage.stageKey)!;

    const on = t!.services.tooling.openAgentSession(task, { ...def, permissionLevel: 2 }, stage, repo)!;
    expect(on.bridge?.args).toEqual([tooling.d.bridgePath]);
    expect(on.shellGuard?.args).toEqual([tooling.d.shellGuardPath]);
    expect(on.shellGuard?.env).toEqual(on.bridge?.env);
    on.close();

    const settings = (await t!.api('GET', '/api/settings')).body;
    expect((await t!.api('PATCH', '/api/settings', { execution: { ...settings.execution, exposeToolsToAgents: false } })).status).toBe(200);
    const off = t!.services.tooling.openAgentSession(task, { ...def, permissionLevel: 2 }, stage, repo)!;
    expect(off.bridge).toBeNull();
    const token = off.shellGuard!.env.ACC_TOOL_SESSION!;
    expect((await t!.api('GET', '/api/tool-session/tools', undefined, sessionHeaders(token))).status).toBe(403);
    expect((await t!.api('POST', '/api/tool-session/call', { capability: 'fs.read', input: { path: 'README.md' } }, sessionHeaders(token))).status).toBe(403);
    expect((await t!.api('POST', '/api/tool-session/precheck', { command: 'npm test' }, sessionHeaders(token))).body).toEqual({ decision: 'allow' });
    off.close();
    // Without the built guard and without tools, there is no session at all: the adapter then runs without a shell.
    tooling.d.shellGuardPath = null;
    expect(t!.services.tooling.openAgentSession(task, { ...def, permissionLevel: 2 }, stage, repo)).toBeNull();
    await t!.api('POST', `/api/tasks/${taskId}/cancel`);
  }, 60_000);
});
