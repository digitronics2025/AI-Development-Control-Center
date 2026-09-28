import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '@acc/agent-claude';
import { CodexAdapter } from '@acc/agent-codex';
import { LAUNCH_TICKET_TTL_MS, LaunchTickets } from '../src/http/launch-tickets.js';
import { agentAccountFile, agentAccountGrants } from '../src/services/agent-isolation.js';
import { addRepo, createTask, createTestApp, makeRepo, ROOT, TOKEN, waitFor, waitForStatus, type TestApp } from './helpers.js';

/**
 * The agent OS boundary (SEC-3, docs/systems/security.md#agent-os-boundary):
 * the local-only setting, stage runs that start as the agent account or not at
 * all, the privileged helper's account operations, and launch tickets.
 */

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

function dashboardBuild(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-dash-'));
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  writeFileSync(path.join(dir, 'assets', 'index-a.js'), 'console.log(1)');
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><script type="module" src="/assets/index-a.js"></script></head><body></body></html>');
  return dir;
}

const page = (url: string, headers: Record<string, string> = {}) => t!.app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317', ...headers } });
const tokenMeta = `<meta name="acc-token" content="${TOKEN}">`;
const isolate = () => t!.api('PATCH', '/api/settings', { agentIsolation: { mode: 'account' } });

describe('the setting', () => {
  it('is off by default and changes on this machine', async () => {
    t = await createTestApp();
    expect(t.services.settings.get().agentIsolation).toEqual({ mode: 'off', account: 'acc-agent' });
    expect(t.services.agents.stageRunAs()).toBeUndefined();
    expect((await isolate()).status).toBe(200);
    expect(t.services.agents.stageRunAs()).toEqual({ account: 'acc-agent', credentialFile: agentAccountFile(t.dataDir), relay: path.join(ROOT, 'scripts', 'windows', 'agent-relay.ps1') });
    expect((await t.api('PATCH', '/api/settings', { agentIsolation: { account: 'no' } })).status).toBe(400);
    expect((await t.api('PATCH', '/api/settings', { agentIsolation: { mode: 'off' } })).status).toBe(200);
    expect(t.services.agents.stageRunAs()).toBeUndefined();
  });
});

describe('launch tickets', () => {
  it('are single use, expire after a minute, and only issued ones count', () => {
    let now = 1_000_000;
    const tickets = new LaunchTickets(() => now);
    const a = tickets.issue();
    expect(a.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tickets.consume(a.ticket)).toBe(true);
    expect(tickets.consume(a.ticket)).toBe(false);
    expect(tickets.consume('made-up')).toBe(false);
    expect(tickets.consume('')).toBe(false);
    const b = tickets.issue();
    now += LAUNCH_TICKET_TTL_MS;
    expect(tickets.consume(b.ticket)).toBe(false);
    // At most 32 wait unused: the oldest goes first.
    const many = Array.from({ length: 33 }, () => tickets.issue().ticket);
    expect(tickets.consume(many[0])).toBe(false);
    expect(tickets.consume(many[32])).toBe(true);
  });

  it('with agent isolation off, change nothing: every page load carries the token', async () => {
    t = await createTestApp({ dashboardDir: dashboardBuild() });
    for (const url of ['/', '/tasks/TASK-0001', '/?ticket=made-up']) {
      const res = await page(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain(tokenMeta);
    }
  });

  it('with agent isolation on, the page carries the token only for a fresh ticket from the authenticated API', async () => {
    t = await createTestApp({ dashboardDir: dashboardBuild() });
    await isolate();
    for (const url of ['/', '/tasks/TASK-0001', '/?ticket=made-up', '/vault-bridge']) {
      const res = await page(url);
      expect(res.statusCode, url).toBe(403);
      expect(res.body, url).not.toContain(TOKEN);
      expect(res.body, url).toMatch(/Open the AI Development Control Center from its launcher/);
    }
    // No token, no ticket; and never for the cloud.
    expect((await t.app.inject({ method: 'POST', url: '/api/launch-tickets', headers: { host: '127.0.0.1:4317' } })).statusCode).toBe(401);
    expect((await t.api('POST', '/api/launch-tickets', {}, { 'x-acc-remote-request': '1' })).status).toBe(403);

    const issued = await t.api('POST', '/api/launch-tickets', {});
    expect(issued.status).toBe(201);
    expect(issued.body.path).toBe(`/?ticket=${issued.body.ticket}`);
    const opened = await page(issued.body.path);
    expect(opened.statusCode).toBe(200);
    expect(opened.body).toContain(tokenMeta);
    expect(opened.headers['cache-control']).toBe('no-store');
    // Spent: a reload, or anyone else with the link, gets no token.
    const again = await page(issued.body.path);
    expect(again.statusCode).toBe(403);
    expect(again.body).not.toContain(TOKEN);
    // A deep link opens with a ticket too.
    const deep = await t.api('POST', '/api/launch-tickets', {});
    expect((await page(`/tasks/TASK-0001?ticket=${deep.body.ticket}`)).body).toContain(tokenMeta);
    // Assets and the API are unchanged.
    expect((await page('/assets/index-a.js')).statusCode).toBe(200);
    expect((await t.api('GET', '/api/settings')).status).toBe(200);
  });
});

describe('stage runs as the agent account', () => {
  const fixture = (name: string) => path.join(ROOT, 'tests', 'fixtures', process.platform === 'win32' ? `${name}.cmd` : name);

  it('fail closed, with the reason, when the account is not set up — the CLI never starts as the operator', async () => {
    const argsFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-iso-')), 'args.json');
    t = await createTestApp({ adapters: [new CodexAdapter(), new ClaudeCodeAdapter()], baseEnv: { ...process.env, FAKE_ARGS_FILE: argsFile } });
    await t.api('PATCH', '/api/agents/claude', { executablePath: fixture('fake-claude') });
    await t.api('PATCH', '/api/agents/codex', { executablePath: fixture('fake-codex') });
    await t.services.agents.refresh();
    await isolate();
    const copy = (await t.api('POST', '/api/workflows/quick-change/duplicate', {})).body;
    await t.api('PUT', `/api/workflows/${copy.id}`, { ...copy, stages: [{ key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, next: 'complete' }] });
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Should not run as me', { workflowId: copy.id, supervised: false });
    await waitForStatus(t, id, ['WAITING_FOR_USER', 'FAILED', 'COMPLETED']);
    const executions = t.services.store.listExecutions(id).filter((e) => e.kind === 'agent');
    expect(executions.length).toBeGreaterThan(0);
    for (const e of executions) {
      expect(e.status).toBe('failed');
      expect(e.errorClass).toBe('PERMISSION_DENIED');
      expect(e.errorMessage).toMatch(process.platform === 'win32' ? /^Agent isolation: agent runs are set to start as the Windows account "acc-agent", but it is not set up on this computer/ : /Windows only/);
    }
    expect(existsSync(argsFile)).toBe(false);
  }, 60_000);

  it("get no Control Center tools, which run as the operator; the native shell precheck stays", async () => {
    t = await createTestApp();
    const taskId = await createTask(t, await addRepo(t, await makeRepo()), 'Isolated [sim:hang]', { workflowId: 'quick-change', supervised: false });
    const stage = (await waitFor(() => t!.services.store.listStages(taskId).find((s) => s.status === 'RUNNING'), (s) => Boolean(s), 30_000, 'a running stage'))!;
    const tooling = t.services.tooling as unknown as { d: { shellGuardPath: string | null; bridgePath: string | null } };
    tooling.d.shellGuardPath = path.join(t.dataDir, 'stand-in-guard.js');
    tooling.d.bridgePath = path.join(t.dataDir, 'stand-in-bridge.js');
    t.services.tooling.setListenUrl('http://127.0.0.1:1');
    const task = t.services.store.getTask(taskId)!;
    const repo = t.services.store.getRepository(task.repositoryId)!;
    const def = { ...task.workflow.stages.find((s) => s.key === stage.stageKey)!, permissionLevel: 2 as const };
    const open = () => t!.services.tooling.openAgentSession(task, def, stage, repo)!;
    const asOperator = open();
    expect(asOperator.bridge).not.toBeNull();
    expect(t.services.tooling.toolsPromptSection(task, def, repo)).toMatch(/Control Center tools/);
    asOperator.close();

    expect((await isolate()).status).toBe(200);
    const isolated = open();
    expect(isolated.bridge).toBeNull();
    expect(t.services.tooling.toolsPromptSection(task, def, repo)).toBe('');
    const headers = { authorization: `Bearer ${isolated.shellGuard!.env.ACC_TOOL_SESSION}` };
    // The tool door is shut, so shell.run cannot run a command as the operator for the run.
    expect((await t.api('POST', '/api/tool-session/call', { capability: 'shell.run', input: { script: 'echo x' } }, headers)).status).toBe(403);
    expect((await t.api('GET', '/api/tool-session/tools', undefined, headers)).status).toBe(403);
    expect((await t.api('POST', '/api/tool-session/precheck', { command: 'npm test' }, headers)).body).toEqual({ decision: 'allow' });
    const refused = (await t.api('POST', '/api/tool-session/precheck', { command: 'git push origin HEAD' }, headers)).body;
    expect(refused.decision).toBe('deny');
    expect(refused.reason).not.toMatch(/shell\.run/);
    isolated.close();
    await t.api('POST', `/api/tasks/${taskId}/cancel`);
  }, 60_000);
});

describe('agentAccountGrants', () => {
  it('lists the existing program folders inside the user folder, once each', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'acc-home-'));
    const build = path.join(home, 'acc', 'apps', 'orchestrator', 'dist');
    const cli = path.join(home, '.local', 'bin');
    mkdirSync(build, { recursive: true });
    mkdirSync(cli, { recursive: true });
    const outside = mkdtempSync(path.join(os.tmpdir(), 'acc-programs-'));
    const grants = agentAccountGrants({ home, buildDir: build, nodePath: path.join(outside, 'node.exe'), executables: [path.join(cli, 'claude.exe'), path.join(cli, 'other.exe'), null, path.join(home, 'gone', 'codex.cmd'), path.join(home, 'x.exe')] });
    expect(grants).toEqual([build, cli]);
  });
});

describe.skipIf(process.platform !== 'win32')("the privileged helper's agent account operations (validation only, never run here)", () => {
  it('fills in the account, the work root and the program folders, and describes what it would change', async () => {
    t = await createTestApp();
    const r = await t.services.privileged.validate('agent_account_create', {});
    expect(r, r.message).toMatchObject({ ok: true });
    expect(r.message).toContain('create the standard Windows account acc-agent');
    expect(r.message).toContain(t.workDir);
    expect(r.message).toContain(t.dataDir);
    expect((await t.services.privileged.validate('agent_account_remove', {})).message).toMatch(/There is no agent account acc-agent to remove/);
  }, 120_000);

  it('refuses bad names, and folders that are not plain program or work folders', async () => {
    t = await createTestApp();
    const home = os.homedir();
    const refused = async (params: Record<string, unknown>, pattern: RegExp) => {
      const r = await t!.services.privileged.validate('agent_account_create', params);
      expect(r.ok, JSON.stringify(params)).toBe(false);
      expect(r.message, JSON.stringify(params)).toMatch(pattern);
    };
    await refused({ account: 'x' }, /Account name/);
    await refused({ account: 'bad name!' }, /Account name/);
    await refused({ workDir: path.join(t.dataDir, 'work') }, /data folder/);
    await refused({ workDir: path.dirname(t.dataDir) }, /data folder/);
    await refused({ workDir: 'C:\\' }, /not a full local folder path|too close/);
    await refused({ workDir: 'relative\\work' }, /not a full local folder path/);
    await refused({ workDir: `${t.workDir}\\..\\elsewhere` }, /plain form/);
    await refused({ workDir: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Temp', 'acc') }, /system or program folder/);
    await refused({ workDir: home }, /user folder root/);
    await refused({ read1: path.join(home, '.ssh') }, /credentials/);
    await refused({ read1: path.join(home, 'no-such-folder-acc') }, /does not exist/);
    const own = os.userInfo().username;
    if (/^[A-Za-z][A-Za-z0-9_-]{2,19}$/.test(own)) await refused({ account: own }, /was not made by the Control Center/);
  }, 240_000);
});
