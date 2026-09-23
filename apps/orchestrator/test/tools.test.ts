import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { git } from '@acc/git';
import { schemaVersion } from '../src/db/database.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { addRepo, createTask, createTestApp, makeRepo, ROOT, TOKEN, waitFor, waitForStatus, type TestApp } from './helpers.js';

/**
 * The tool layer through the real orchestrator (docs/plans/tool-layer-v2):
 * API and session security, policy decisions, the credential broker, task
 * processes, repairs in test stages, the verify stage, worktree isolation,
 * terminals, MCP servers and the privileged helper's validation.
 */

let t: TestApp;
let repoPath: string;
let repoId: string;

beforeAll(async () => {
  t = await createTestApp();
  repoPath = await makeRepo({ files: { 'notes.txt': 'hello tools\n' } });
  repoId = await addRepo(t, repoPath);
}, 60_000);

afterAll(async () => {
  await t.close();
});

const sessionHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

describe('schema and registry', () => {
  it('applies the tool layer migration and lists tools with their capabilities', async () => {
    expect(schemaVersion(t.services.db)).toBe(Math.max(...MIGRATIONS.map((m) => m.version)));
    const tables = (t.services.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const table of ['tools', 'tool_capabilities', 'tool_health', 'tool_executions', 'pty_sessions', 'task_processes', 'recovery_attempts', 'mcp_servers', 'capability_escalations', 'credential_references']) expect(tables).toContain(table);
    const tools = await t.api('GET', '/api/tools');
    expect(tools.status).toBe(200);
    expect(tools.body.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(['git', 'powershell', 'filesystem', 'playwright', 'wrangler', 'adb', 'docker', 'environment']));
    const check = await t.api('POST', '/api/tools/git/check', {});
    expect(check.body).toMatchObject({ id: 'git', installed: true, state: 'ready' });
    expect(check.body.version).toMatch(/^\d+\.\d+/);
  });
});

describe('operator tool calls and policy', () => {
  it('runs a read, refuses destructive work without confirmation, and records every call', async () => {
    const read = await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'fs.read', input: { path: 'notes.txt' } });
    expect(read.status).toBe(200);
    expect(read.body.result.output.content).toBe('hello tools\n');
    const destructive = await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'shell.run', input: { script: 'Remove-Item -Recurse -Force src' } });
    expect(destructive.body.decision).toBe('approval');
    expect(destructive.body.execution.status).toBe('needs_approval');
    const outside = await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'fs.read', input: { path: '../../Windows/win.ini' } });
    expect(outside.body.result.error.code).toBe('OUTSIDE_ROOT');
    const executions = await t.api('GET', '/api/tool-executions?limit=10');
    expect(executions.body.map((e: { capability: string; status: string }) => `${e.capability}:${e.status}`)).toEqual(expect.arrayContaining(['fs.read:succeeded', 'shell.run:needs_approval', 'fs.read:failed']));
  });

  it('gives agents a scoped session: within the stage level, escalates outside the profile, refuses above it', async () => {
    const session = t.services.tools.openSession(
      { taskId: null, stageId: null, repositoryId: repoId, cwd: repoPath, roots: [repoPath], stageLevel: 1, autoApproveUpToLevel: 3, mode: 'autopilot', profile: 'analysis', protectedPaths: [] },
      'agent',
    );
    const list = await t.api('GET', '/api/tool-session/tools', undefined, sessionHeaders(session.token));
    expect(list.status).toBe(200);
    const listed = list.body.tools.map((x: { capability: string }) => x.capability);
    expect(listed).toContain('network.port_owner');
    expect(listed).not.toContain('fs.write');
    expect(listed).not.toContain('fs.read'); // natively available to agents: callable, not listed
    const write = await t.api('POST', '/api/tool-session/call', { capability: 'fs.write', input: { path: 'x.txt', content: 'x' } }, sessionHeaders(session.token));
    expect(write.body).toMatchObject({ ok: false, decision: 'deny' });
    expect(write.body.text).toMatch(/Level 1/);
    expect(existsSync(path.join(repoPath, 'x.txt'))).toBe(false);
    const escalated = await t.api('POST', '/api/tool-session/call', { capability: 'git.worktree_list', input: {} }, sessionHeaders(session.token));
    expect(escalated.body.ok).toBe(true);
    const find = await t.api('POST', '/api/tool-session/find', { query: 'port owner' }, sessionHeaders(session.token));
    expect(find.body.text).toMatch(/network\.port_owner/);
    t.services.tools.closeSession(session.id);
    expect((await t.api('GET', '/api/tool-session/tools', undefined, sessionHeaders(session.token))).status).toBe(401);
  });

  it('keeps session tokens and the API token apart', async () => {
    const opened = await t.api('POST', '/api/tool-sessions', { repository: repoPath });
    expect(opened.status).toBe(201);
    const token = opened.body.token as string;
    expect(token).not.toBe(TOKEN);
    expect((await t.api('GET', '/api/tool-session/tools', undefined, sessionHeaders(token))).status).toBe(200);
    // The local API token does not open tool-session routes…
    expect((await t.api('GET', '/api/tool-session/tools')).status).toBe(401);
    // …and a session token opens nothing else.
    expect((await t.api('GET', '/api/tasks', undefined, sessionHeaders(token))).status).toBe(401);
    expect((await t.api('POST', '/api/tool-sessions', { repository: repoPath }, sessionHeaders(token))).status).toBe(401);
    // Host checks still apply to session routes.
    expect((await t.api('GET', '/api/tool-session/tools', undefined, { ...sessionHeaders(token), host: 'evil.example:4317' })).status).toBe(421);
  });
});

describe('credential broker', () => {
  let server: http.Server;
  let seen: string | undefined;
  let url: string;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen = req.headers.authorization;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ echoed: req.headers.authorization }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/whoami`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('stores values sealed, never returns them, injects them into one call and redacts echoes', async () => {
    const value = ['brokered', 'secret', 'value', '0042'].join('-');
    const created = await t.api('POST', '/api/credentials', { name: 'test-api', kind: 'http', value, description: 'fixture' });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain(value);
    expect(created.body.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    const listed = await t.api('GET', '/api/credentials');
    expect(JSON.stringify(listed.body)).not.toContain(value);
    // Nothing in SQLite holds the value in plain text.
    t.services.db.pragma('wal_checkpoint(FULL)');
    expect(readFileSync(path.join(t.dataDir, 'acc.db')).includes(Buffer.from(value))).toBe(false);

    const call = await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'http.request', input: { url, auth: { credential: 'test-api' } } });
    expect(call.body.result.ok).toBe(true);
    expect(seen).toBe(`Bearer ${value}`);
    expect(JSON.stringify(call.body)).not.toContain(value);
    const missing = await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'http.request', input: { url, auth: { credential: 'nope' } } });
    expect(missing.body.result.error.code).toBe('AUTH_REQUIRED');
  }, 60_000);
});

describe('task processes', () => {
  it('starts a server, waits for health, knows it owns it, and stops it as a tree', async () => {
    const script = path.join(repoPath, 'server.cjs');
    writeFileSync(script, "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n");
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const proc = await t.services.processes.start({ taskId: 'TASK-P', stageId: null, name: 'fixture server', command: `node "${script}"`, cwd: repoPath, port, readyTimeoutSec: 30 });
    expect(proc.status).toBe('healthy');
    const owner = await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'network.port_owner', input: { port } });
    const pid = owner.body.result.output.owners[0].pid as number;
    expect(t.services.processes.owns('TASK-P', pid)).toBe(true);
    expect(t.services.processes.owns('TASK-OTHER', pid)).toBe(false);
    // A second start on the same port reports who holds it instead of fighting over it.
    const clash = await t.services.processes.start({ taskId: 'TASK-P', stageId: null, name: 'again', command: `node "${script}"`, cwd: repoPath, port, readyTimeoutSec: 5 });
    expect(clash).toMatchObject({ status: 'failed', stopReason: `Port ${port} is already in use` });
    expect(await t.services.processes.stopForTask('TASK-P', 'test')).toBe(1);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}`).then(() => 'up', () => 'down')), (v) => v === 'down', 15_000, 'port to close');
  }, 90_000);
});

describe('engine integration', () => {
  it('repairs a missing dependency in the test stage, then passes', async () => {
    const dir = await makeRepo({
      scripts: { test: "node -e \"require('localdep'); console.log('1 passed')\"" },
      files: { 'package.json': JSON.stringify({ name: 'fixture', private: true, scripts: { test: "node -e \"require('localdep'); console.log('1 passed')\"" }, dependencies: { localdep: 'file:./localdep' } }, null, 2) },
    });
    mkdirSync(path.join(dir, 'localdep'));
    writeFileSync(path.join(dir, 'localdep', 'package.json'), JSON.stringify({ name: 'localdep', version: '1.0.0', main: 'index.js' }));
    writeFileSync(path.join(dir, 'localdep', 'index.js'), 'module.exports = 1;\n');
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-m', 'add local dependency']);
    const id = await addRepo(t, dir);
    const repo = await t.api('GET', `/api/repositories/${id}`);
    await t.api('PATCH', `/api/repositories/${id}`, { commands: repo.body.commands.filter((c: { kind: string }) => c.kind === 'test') });
    const taskId = await createTask(t, id, 'Use the local dependency', { workflowId: 'quick-change', supervised: false });
    const done = await waitForStatus(t, taskId, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 240_000);
    expect(done.status).toBe('COMPLETED');
    const recovery = t.services.toolStore.listRecovery(taskId);
    expect(recovery.map((r) => `${r.category}:${r.strategy}:${r.status}`)).toEqual(['missing_dependency:install_dependencies:failed', 'missing_dependency:install_dependencies_unfrozen:succeeded']);
    const runs = t.services.store.listTestRuns(taskId).filter((r) => r.kind === 'test');
    expect(runs.at(-1)).toMatchObject({ status: 'passed' });
    expect(runs.at(-1)!.summary).toMatch(/after repair/);
    const events = t.services.store.listEvents(taskId, { limit: 500 }).map((e) => e.type);
    expect(events).toContain('RECOVERY_ATTEMPT');
    expect(events).toContain('ENVIRONMENT_DISCOVERED');
  }, 300_000);

  it('verifies the app in a real browser and sends console errors back to the fixer', async () => {
    const { findBrowser } = await import('@acc/tools');
    if (!(await findBrowser())) return;
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const server = `require('http').createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(require('fs').readFileSync(__dirname + '/page.html')); }).listen(${port}, '127.0.0.1');\n`;
    const dir = await makeRepo({ files: { 'server.cjs': server, 'page.html': '<!doctype html><meta name="viewport" content="width=device-width"><title>x</title><script>console.error("broken build")</script><h1>App</h1>' } });
    const id = await addRepo(t, dir);
    await t.api('PATCH', `/api/repositories/${id}`, { runtime: { devCommand: 'node server.cjs', devUrl: `http://127.0.0.1:${port}`, verifyPaths: ['/'], verifyMode: 'browser', readyTimeoutSec: 30 } });
    t.services.workflows.save('verify-loop', {
      name: 'Verify loop',
      maxFixCycles: 1,
      stages: [
        { key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, next: 'app' },
        { key: 'app', name: 'App check', role: 'tester', kind: 'verify', permissionLevel: 2, next: 'complete', onFail: 'fix' },
        { key: 'fix', name: 'Fix', role: 'fixer', permissionLevel: 2, next: 'app' },
      ],
    });
    // The simulated fixer cannot repair the page, so after one fix the loop stops at the fix limit.
    const taskId = await createTask(t, id, 'Check the app', { workflowId: 'verify-loop', supervised: false });
    const parked = await waitForStatus(t, taskId, ['WAITING_FOR_USER', 'COMPLETED', 'FAILED'], 180_000);
    expect(parked.status).toBe('WAITING_FOR_USER');
    expect(parked.blocker?.kind).toBe('fix_limit');
    const stages = t.services.store.listStages(taskId).filter((s) => s.kind === 'verify');
    expect(stages.every((s) => s.status === 'FAILED')).toBe(true);
    expect(stages[0]!.errorMessage).toMatch(/console error: broken build/);
    const artifacts = t.services.store.listArtifacts(taskId).map((a) => a.type);
    expect(artifacts).toContain('browser-report');
    expect(artifacts).toContain('screenshot');
    // The app server was stopped each time: nothing listens any more.
    expect(t.services.processes.list(taskId).every((p) => !['running', 'healthy', 'starting'].includes(p.status))).toBe(true);

    // Fix the page by hand and resume: the check passes and the task completes.
    writeFileSync(path.join(dir, 'page.html'), '<!doctype html><meta name="viewport" content="width=device-width"><title>x</title><h1>App</h1>');
    await t.api('POST', `/api/tasks/${taskId}/resume`);
    const done = await waitForStatus(t, taskId, ['COMPLETED', 'WAITING_FOR_USER', 'FAILED'], 180_000);
    expect(done.status).toBe('COMPLETED');
    const report = readFileSync(path.join(t.dataDir, 'tasks', taskId, 'final-report.md'), 'utf8');
    expect(report).toMatch(/## Verification coverage/);
    expect(report).toMatch(/## Execution/);
  }, 400_000);

  it('runs an isolated task in a worktree: your working tree is untouched and the work lands on its branch', async () => {
    const dir = await makeRepo({ dirty: { 'README.md': '# my uncommitted edit\n' } });
    const id = await addRepo(t, dir);
    await t.api('PATCH', `/api/repositories/${id}`, { gitMode: 'worktree' });
    const taskId = await createTask(t, id, 'Isolated change', { workflowId: 'quick-change', supervised: false });
    const done = await waitForStatus(t, taskId, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 180_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.git.isolated).toBe(true);
    expect(done.git.worktreePath).toBeNull();
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# my uncommitted edit\n');
    expect(existsSync(path.join(dir, 'sim-output.md'))).toBe(false);
    const onBranch = await git(dir, ['show', `${done.git.taskBranch}:sim-output.md`]);
    expect(onBranch.code).toBe(0);
    expect((await git(dir, ['worktree', 'list'])).stdout.trim().split('\n')).toHaveLength(1);
    const changes = await t.api('GET', `/api/tasks/${taskId}/changes`);
    expect(changes.body.files.map((f: { path: string }) => f.path)).toEqual(['sim-output.md']);
    const events = t.services.store.listEvents(taskId, { limit: 200 }).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(['WORKTREE_CREATED', 'WORKTREE_REMOVED']));
  }, 200_000);
});

describe('hardening', () => {
  it('after a restart, stops a leftover process only while it is still the same process', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    const alive = () => {
      try {
        process.kill(child.pid!, 0);
        return true;
      } catch {
        return false;
      }
    };
    const row = (id: string, processStartedAt: string) => ({
      id, taskId: 'TASK-R', stageId: null, name: 'leftover', command: 'node', cwd: repoPath, pid: child.pid!, port: null, url: null,
      status: 'running' as const, startedAt: processStartedAt, stoppedAt: null, exitCode: null, stopReason: null, processStartedAt,
    });
    try {
      // Same pid, but recorded an hour earlier: a reused pid, not ours. Left alone.
      t.services.toolStore.insertProcess(row('proc-reused', new Date(Date.now() - 3_600_000).toISOString()));
      expect(await t.services.processes.reconcileAfterRestart()).toEqual({ stopped: 0, gone: 1 });
      expect(alive()).toBe(true);
      expect(t.services.toolStore.process('proc-reused')).toMatchObject({ status: 'exited', stopReason: 'Gone after a restart' });
      // Same pid and creation time: the previous orchestrator's process. Stopped.
      t.services.toolStore.insertProcess(row('proc-ours', new Date().toISOString()));
      expect(await t.services.processes.reconcileAfterRestart()).toEqual({ stopped: 1, gone: 0 });
      await waitFor(async () => alive(), (v) => v === false, 15_000, 'leftover process to stop');
    } finally {
      if (alive()) child.kill();
    }
  }, 90_000);

  it('cancelling an isolated task stops its processes and removes its worktree, leaving your tree alone', async () => {
    const dir = await makeRepo({ dirty: { 'README.md': '# still mine\n' } });
    const id = await addRepo(t, dir);
    await t.api('PATCH', `/api/repositories/${id}`, { gitMode: 'worktree' });
    const taskId = await createTask(t, id, 'Slow isolated change [sim:slow]', { workflowId: 'quick-change', supervised: false });
    const running = await waitFor(
      async () => (await t.api('GET', `/api/tasks/${taskId}`)).body,
      (d) => d.status === 'RUNNING' && Boolean(d.git?.worktreePath),
      60_000,
      'task running in its worktree',
    );
    const worktree = running.git.worktreePath as string;
    expect(existsSync(worktree)).toBe(true);
    const script = path.join(worktree, 'idle.cjs');
    writeFileSync(script, 'setInterval(() => {}, 1000);\n');
    const proc = await t.services.processes.start({ taskId, stageId: null, name: 'idle', command: `node "${script}"`, cwd: worktree });
    expect(proc.status).toBe('running');

    expect((await t.api('POST', `/api/tasks/${taskId}/cancel`)).status).toBe(200);
    const cancelled = await waitForStatus(t, taskId, ['CANCELLED'], 60_000);
    expect(cancelled.git.worktreePath).toBeNull();
    await waitFor(async () => t.services.processes.list(taskId).map((p) => p.status), (s) => s.every((x) => !['running', 'healthy', 'starting'].includes(x)), 30_000, 'task processes to stop');
    await waitFor(async () => existsSync(worktree), (v) => v === false, 30_000, 'worktree folder to go');
    expect((await git(dir, ['worktree', 'list'])).stdout.trim().split('\n')).toHaveLength(1);
    expect(readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# still mine\n');
    const events = t.services.store.listEvents(taskId, { limit: 200 }).map((e) => e.type);
    expect(events).toContain('WORKTREE_REMOVED');
  }, 180_000);
});

describe('terminals', () => {
  it('opens a real terminal in a repository, streams output and closes it', async () => {
    const opened = await t.api('POST', '/api/terminals', { repositoryId: repoId, cols: 100, rows: 30 });
    expect(opened.status).toBe(201);
    const id = opened.body.id as string;
    t.services.terminals.write(id, process.platform === 'win32' ? 'Write-Output ("term-" + (20 + 22))\r' : 'echo term-$((20 + 22))\r');
    await waitFor(() => t.services.terminals.read(id).output, (o) => o.includes('term-42'), 20_000, 'terminal output');
    const output = await t.api('GET', `/api/terminals/${id}/output?since=0`);
    expect(output.body.output).toContain('term-42');
    expect((await t.api('DELETE', `/api/terminals/${id}`)).status).toBe(200);
    const list = await t.api('GET', '/api/terminals');
    expect(list.body.find((x: { id: string }) => x.id === id).status).toBe('exited');
  }, 60_000);

  it('refuses dangerous input typed by an agent', async () => {
    const opened = await t.api('POST', '/api/terminals', { repositoryId: repoId });
    const id = opened.body.id as string;
    expect(() => t.services.terminals.writeAsAgent(id, 'Remove-Item -Recurse -Force C:\\work\r', 2)).toThrow(/Refused/);
    await t.api('DELETE', `/api/terminals/${id}`);
  }, 60_000);
});

describe('MCP servers', () => {
  it('registers a real stdio server, discovers its tools and calls one through the policy', async () => {
    const fixture = path.join(ROOT, 'packages', 'mcp', 'test', 'fixtures', 'echo-server.mjs');
    const created = await t.api('POST', '/api/mcp', { name: 'Echo fixture', transport: 'stdio', command: process.execPath, args: [fixture], permissionLevel: 1 });
    expect(created.status).toBe(201);
    expect(created.body.health).toMatchObject({ ok: true, serverName: 'echo-fixture' });
    const caps = await t.api('GET', '/api/tools/capabilities');
    expect(caps.body.map((c: { id: string }) => c.id)).toContain('mcp.echo_fixture.echo');
    const call = await t.api('POST', '/api/tools/call', { repositoryId: repoId, capability: 'mcp.echo_fixture.echo', input: { text: 'via gateway' } });
    expect(call.body.result).toMatchObject({ ok: true, stdout: 'echo: via gateway' });
    expect((await t.api('DELETE', `/api/mcp/${created.body.id}`)).status).toBe(200);
    expect((await t.api('GET', '/api/tools/capabilities')).body.map((c: { id: string }) => c.id)).not.toContain('mcp.echo_fixture.echo');
  }, 60_000);
});

describe.skipIf(process.platform !== 'win32')('privileged helper validation (real PowerShell, never elevated here)', () => {
  it('accepts allowlisted, well-formed requests and refuses everything else', async () => {
    expect(await t.services.privileged.validate('firewall_allow_port', { port: 5199, name: 'verify' })).toMatchObject({ ok: true, message: expect.stringMatching(/Valid: allow inbound TCP 5199/) });
    expect(await t.services.privileged.validate('install_package', { id: 'Git.Git' })).toMatchObject({ ok: true });
    expect(await t.services.privileged.validate('install_package', { id: 'Evil.Package' })).toMatchObject({ ok: false, message: expect.stringMatching(/not on the allowlist/) });
    expect(await t.services.privileged.validate('run_anything', { command: 'calc' })).toMatchObject({ ok: false, message: expect.stringMatching(/not allowed/) });
    expect(await t.services.privileged.validate('firewall_allow_port', { port: 80, name: 'x' })).toMatchObject({ ok: false });
    expect(await t.services.privileged.validate('service_stop', { name: 'WinDefend' })).toMatchObject({ ok: false });
  }, 120_000);

  it('refuses a tampered request', async () => {
    const file = t.services.privileged.prepare('firewall_allow_port', { port: 5199, name: 'verify' });
    const request = JSON.parse(readFileSync(file, 'utf8'));
    request.payload = request.payload.replace('5199', '5200');
    writeFileSync(file, JSON.stringify(request));
    const { runProcess } = await import('@acc/executor');
    const r = await runProcess({ command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'windows', 'privileged-helper.ps1'), '-RequestFile', file, '-ValidateOnly'], cwd: t.dataDir, env: { ...process.env, ACC_DATA_DIR: t.dataDir }, timeoutMs: 60_000 }).done;
    expect(r.exitCode).toBe(1);
    expect(readFileSync(`${file}.result.json`, 'utf8')).toMatch(/Bad signature/);
  }, 120_000);
});
