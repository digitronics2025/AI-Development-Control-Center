import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import { git } from '@acc/git';
import { ClaudeCodeAdapter } from '@acc/agent-claude';
import { CodexAdapter } from '@acc/agent-codex';
import type { ServerMessage } from '@acc/shared';
import { addRepo, createTask, createTestApp, makeRepo, ROOT, TOKEN, waitFor, waitForStatus, type TestApp } from './helpers.js';

let t: TestApp;

beforeEach(async () => {
  SimulatedAgentAdapter.reset();
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

describe('local service security', () => {
  it('rejects requests without the token', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/tasks', headers: { host: '127.0.0.1:4317' } });
    expect(res.statusCode).toBe(401);
    const bad = await t.app.inject({ method: 'GET', url: '/api/tasks', headers: { host: '127.0.0.1:4317', authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);
  });

  it('decides the token check on the path the router matches, not the raw request line (audit F-01)', async () => {
    const host = { host: '127.0.0.1:4317' };
    for (const url of ['/%61pi/tasks', '/%61pi/settings', '/api%2Ftasks', '//api/tasks', '/API/tasks', '/%61pi/tool-session/../tasks', '/%61pi/connected-app/../../api/tasks']) {
      const res = await t.app.inject({ method: 'GET', url, headers: host });
      expect([401, 400], url).toContain(res.statusCode);
    }
    expect((await t.app.inject({ method: 'GET', url: '/%E0%A4%A', headers: host })).statusCode).toBe(400);
    // Encoded paths still work for a caller that has the token.
    expect((await t.api('GET', '/%61pi/tasks')).status).toBe(200);
  });

  it('refuses a WebSocket upgrade to an encoded /ws path without the token (audit F-01)', async () => {
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (t.app.server.address() as { port: number }).port;
    const status = (path: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('open', () => {
          ws.close();
          resolve(101);
        });
        ws.on('error', () => resolve(0));
      });
    expect(await status('/%77s')).toBe(401);
    expect(await status('/w%73?token=nope')).toBe(401);
    expect(await status(`/%77s?token=${TOKEN}`)).toBe(101);
  });

  it('rejects non-loopback Host headers (DNS rebinding)', async () => {
    const res = await t.api('GET', '/api/tasks', undefined, { host: 'evil.example.com' });
    expect(res.status).toBe(421);
  });

  it('rejects foreign origins but allows local and VS Code webview origins with CORS', async () => {
    expect((await t.api('GET', '/api/tasks', undefined, { origin: 'https://evil.example.com' })).status).toBe(403);
    const local = await t.app.inject({
      method: 'OPTIONS',
      url: '/api/tasks',
      headers: { host: '127.0.0.1:4317', origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    });
    expect(local.statusCode).toBe(204);
    expect(local.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const webview = await t.api('GET', '/api/tasks', undefined, { origin: 'vscode-webview://abc123' });
    expect(webview.status).toBe(200);
  });

  it('serves an unauthenticated liveness probe that reveals nothing', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz', headers: { host: 'localhost:4317' } });
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('reports health and binds to localhost', async () => {
    const res = await t.api('GET', '/api/health');
    expect(res.body).toMatchObject({ ok: true, billingMode: 'subscription', host: '127.0.0.1' });
  });
});

describe('REST API', () => {
  it('validates input with readable errors', async () => {
    const res = await t.api('POST', '/api/tasks', { description: '', repositoryId: '', workflowId: 'normal-development', mode: 'autopilot' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    const missingRepo = await t.api('POST', '/api/repositories', { path: path.join(ROOT, 'does-not-exist') });
    expect(missingRepo.status).toBe(400);
  });

  it('manages repositories and detects their commands', async () => {
    const repoPath = await makeRepo({ scripts: { lint: 'x', typecheck: 'y', test: 'z', build: 'w' } });
    const created = await t.api('POST', '/api/repositories', { path: repoPath });
    expect(created.status).toBe(201);
    expect(created.body.commands.map((c: { kind: string }) => c.kind)).toEqual(['lint', 'typecheck', 'test', 'build']);
    expect(created.body.status).toMatchObject({ isGitRepo: true, branch: 'main', dirty: false });
    expect((await t.api('POST', '/api/repositories', { path: repoPath })).status).toBe(409);
    await createTask(t, created.body.id, 'something');
    expect((await t.api('DELETE', `/api/repositories/${created.body.id}`)).status).toBe(409);
  });

  it('reports repository status from one Git call: head, changes, detached HEAD and plain folders', async () => {
    const repoPath = await makeRepo({ dirty: { 'README.md': 'changed\n', 'new.txt': 'untracked\n' } });
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    const created = await t.api('POST', '/api/repositories', { path: repoPath });
    expect(created.body.status).toMatchObject({ available: true, isGitRepo: true, branch: 'main', head, dirty: true, dirtyCount: 2, error: null });

    await git(repoPath, ['checkout', '--detach']);
    const detached = await t.api('GET', `/api/repositories/${created.body.id}`);
    expect(detached.body.status).toMatchObject({ isGitRepo: true, branch: null, head });

    const plain = mkdtempSync(path.join(os.tmpdir(), 'acc-plain-'));
    const folder = await t.api('POST', '/api/repositories', { path: plain });
    expect(folder.body.status).toMatchObject({ available: true, isGitRepo: false, branch: null, head: null, dirty: false, error: null });
  });

  it('lists built-in workflows as read-only and validates custom ones', async () => {
    const list = await t.api('GET', '/api/workflows');
    expect(list.body.map((w: { id: string }) => w.id).sort()).toEqual(['architecture', 'deep-investigation', 'full-autopilot', 'normal-development', 'quick-change', 'staged-review']);
    expect((await t.api('PUT', '/api/workflows/normal-development', list.body[0])).status).toBe(409);
    const copy = await t.api('POST', '/api/workflows/quick-change/duplicate', {});
    expect(copy.status).toBe(201);
    const broken = { ...copy.body, stages: copy.body.stages.map((s: { key: string }) => (s.key === 'review' ? { ...s, next: 'nowhere' } : s)) };
    const invalid = await t.api('PUT', `/api/workflows/${copy.body.id}`, broken);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details[0]).toMatchObject({ stageIndex: 2, field: 'next' });
    const saved = await t.api('PUT', `/api/workflows/${copy.body.id}`, { ...copy.body, name: 'My quick change' });
    expect(saved.body).toMatchObject({ name: 'My quick change', version: 2, builtin: false });
    expect((await t.api('DELETE', `/api/workflows/${copy.body.id}`)).status).toBe(204);
  });

  it('versions prompt templates', async () => {
    const before = (await t.api('GET', '/api/prompts')).body.find((p: { role: string }) => p.role === 'planner');
    const updated = await t.api('PUT', '/api/prompts/planner', { body: 'Plan {{request}}' });
    expect(updated.body.version).toBe(before.version + 1);
    const reset = await t.api('POST', '/api/prompts/planner/reset');
    expect(reset.body).toMatchObject({ version: before.version + 2, builtin: true });
  });

  it('refuses a template with a placeholder the builder never fills, and saves no version for it', async () => {
    const before = (await t.api('GET', '/api/prompts')).body.find((p: { role: string }) => p.role === 'fixer');
    const refused = await t.api('PUT', '/api/prompts/fixer', { body: 'Fix {{request}} using {{ magic_context }} and {{nope}}' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('{{magic_context}}, {{nope}}');
    const after = (await t.api('GET', '/api/prompts')).body.find((p: { role: string }) => p.role === 'fixer');
    expect(after.version).toBe(before.version);
  });

  it('updates settings and keeps subscription-only as the default', async () => {
    const settings = (await t.api('GET', '/api/settings')).body;
    expect(settings).toMatchObject({ billingMode: 'subscription', autoApproveUpToLevel: 3, theme: 'dark', defaultMode: 'discuss' });
    const updated = await t.api('PATCH', '/api/settings', { theme: 'light', roleDefaults: { ...settings.roleDefaults, reviewer: { agentId: 'claude', model: 'default', effort: 'high' } } });
    expect(updated.body.theme).toBe('light');
    expect((await t.api('PATCH', '/api/settings', { autoApproveUpToLevel: 9 })).status).toBe(400);
  });

  it('serves logs with pagination and search', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Log me');
    await waitForStatus(t, id, ['COMPLETED']);
    const execs = (await t.api('GET', `/api/tasks/${id}/executions`)).body;
    const agentExec = execs.find((e: { kind: string }) => e.kind === 'agent');
    const logs = (await t.api('GET', `/api/executions/${agentExec.id}/logs?limit=2`)).body;
    expect(logs).toHaveLength(2);
    const next = (await t.api('GET', `/api/executions/${agentExec.id}/logs?after=${logs[1].seq}`)).body;
    expect(next[0].seq).toBe(logs[1].seq + 1);
    const search = (await t.api('GET', `/api/executions/${agentExec.id}/logs?q=step 2`)).body;
    expect(search.every((l: { text: string }) => l.text.includes('step 2'))).toBe(true);
    const artifacts = (await t.api('GET', `/api/tasks/${id}/artifacts`)).body;
    const report = artifacts.find((a: { type: string }) => a.type === 'final-report');
    expect(report.path).toBeUndefined();
    const content = await t.api('GET', `/api/artifacts/${report.id}/content`);
    expect(content.body.content).toContain('TASK COMPLETED');
    const download = await t.app.inject({
      method: 'GET',
      url: `/api/artifacts/${report.id}/download`,
      headers: { host: '127.0.0.1:4317', authorization: `Bearer ${TOKEN}` },
    });
    expect(download.headers['content-type']).toBe('text/markdown; charset=utf-8');
    const diff = await t.api('GET', `/api/tasks/${id}/diff?path=sim-output.md`);
    expect(diff.body.diff).toContain('sim-output.md');
    expect((await t.api('GET', `/api/tasks/${id}/diff?path=../../etc/passwd`)).status).toBe(400);
  });
});

describe('realtime sync', () => {
  it('pushes task, stage and event updates to every WebSocket client', async () => {
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (t.app.server.address() as { port: number }).port;
    const rejected = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong`);
    const rejectedResult = await new Promise<string>((resolve) => {
      rejected.on('unexpected-response', (req, res) => {
        req.destroy();
        resolve(String(res.statusCode));
      });
      rejected.on('open', () => resolve('open'));
      rejected.on('error', () => resolve('error'));
    });
    expect(rejectedResult).toBe('401');

    const clients = [0, 1].map(() => new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`));
    const received: ServerMessage[][] = [[], []];
    await Promise.all(
      clients.map(
        (ws, i) =>
          new Promise<void>((resolve) => {
            ws.on('message', (raw) => received[i]!.push(JSON.parse(String(raw))));
            ws.on('open', () => resolve());
          }),
      ),
    );
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Sync me');
    await waitForStatus(t, id, ['COMPLETED']);
    // The database changes before the broadcast reaches each socket: wait for delivery.
    const isCompleted = (m: ServerMessage) => m.type === 'task' && m.task.id === id && m.task.status === 'COMPLETED';
    await waitFor(() => received, (all) => all.every((messages) => messages.some(isCompleted)), 10_000, 'COMPLETED on every socket');
    for (const messages of received) {
      expect(messages[0]!.type).toBe('hello');
      const statuses = messages.filter((m): m is Extract<ServerMessage, { type: 'task' }> => m.type === 'task' && m.task.id === id).map((m) => m.task.status);
      expect(statuses).toContain('RUNNING');
      expect(statuses.at(-1)).toBe('COMPLETED');
      expect(messages.some((m) => m.type === 'stage')).toBe(true);
      expect(messages.some((m) => m.type === 'event')).toBe(true);
      // Logs only go to clients that subscribed.
      expect(messages.some((m) => m.type === 'logs')).toBe(false);
    }
    for (const ws of clients) ws.close();
  });
});

describe('real adapters through the engine (fake CLIs)', () => {
  const fixtures = path.join(ROOT, 'tests', 'fixtures');
  const exe = (name: string) => path.join(fixtures, process.platform === 'win32' ? `${name}.cmd` : name);

  async function realApp(env: NodeJS.ProcessEnv) {
    await t.close();
    t = await createTestApp({ adapters: [new CodexAdapter(), new ClaudeCodeAdapter()], baseEnv: { ...process.env, ...env } });
    await t.api('PATCH', '/api/agents/codex', { executablePath: exe('fake-codex') });
    await t.api('PATCH', '/api/agents/claude', { executablePath: exe('fake-claude') });
    await t.services.agents.refresh();
  }

  async function implementOnlyWorkflow() {
    const copy = (await t.api('POST', '/api/workflows/quick-change/duplicate', {})).body;
    const res = await t.api('PUT', `/api/workflows/${copy.id}`, {
      ...copy,
      stages: [{ key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, next: 'test' }, { key: 'test', name: 'Test', role: 'tester', kind: 'tests', permissionLevel: 2, next: 'complete' }],
    });
    expect(res.status).toBe(200);
    return copy.id as string;
  }

  it('runs Claude Code on its subscription and reports agent health', async () => {
    await realApp({ ANTHROPIC_API_KEY: ['sk', 'ant', 'fake', 'must-not-reach-the-cli'].join('-') });
    const agents = (await t.api('GET', '/api/agents')).body;
    expect(agents.find((a: { id: string }) => a.id === 'claude').health).toMatchObject({ state: 'connected', billing: 'subscription' });
    expect(agents.find((a: { id: string }) => a.id === 'codex').detection).toMatchObject({ found: true, version: '9.9.9' });
    const workflowId = await implementOnlyWorkflow();
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Say pong', { workflowId });
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    expect(task.status).toBe('COMPLETED');
    const report = await t.services.artifacts.latestText(id, 'implementation-report');
    expect(report).toContain('ENV_HAS_ANTHROPIC_KEY=no');
  });

  it('refuses to run an agent signed in with API billing in Subscription Only mode', async () => {
    await realApp({ FAKE_CLAUDE_AUTH: 'apikey' });
    const claude = (await t.api('GET', '/api/agents')).body.find((a: { id: string }) => a.id === 'claude');
    expect(claude.health.state).toBe('api_billing_blocked');
    const workflowId = await implementOnlyWorkflow();
    // Unsupervised: the legacy wait. Supervised tasks reroute instead (chairman.test.ts).
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Should not run', { workflowId, supervised: false });
    const task = await waitForStatus(t, id, ['WAITING_FOR_USER', 'COMPLETED', 'FAILED']);
    expect(task.status).toBe('WAITING_FOR_USER');
    expect(task.blocker).toMatchObject({ kind: 'auth', errorClass: 'AUTH_FAILURE' });
    expect(t.services.store.listExecutions(id).every((e) => e.status === 'failed')).toBe(true);
  });

  it('turns a Codex credit exhaustion into WAITING_FOR_USAGE_RESET', async () => {
    await realApp({ FAKE_CODEX_SCENARIO: 'usage' });
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Investigate', { supervised: false });
    const task = await waitForStatus(t, id, ['WAITING_FOR_USAGE_RESET', 'FAILED', 'WAITING_FOR_USER']);
    expect(task.status).toBe('WAITING_FOR_USAGE_RESET');
    expect(task.blocker?.message).toContain('out of credits');
    const exec = t.services.store.listExecutions(id)[0]!;
    expect(exec).toMatchObject({ status: 'failed', errorClass: 'USAGE_LIMIT' });
    expect(exec.command).toContain('codex exec --json');
    await waitFor(() => t.api('GET', `/api/executions/${exec.id}/logs`), (r) => r.body.some((l: { text: string }) => l.text.includes('out of credits')), 5000);
  });
});
