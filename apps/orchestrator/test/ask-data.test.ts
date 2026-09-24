import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter, type AgentExecutionInput } from '@acc/agent-sdk';
import { resetCloudflareCatalog } from '@acc/tools';
import type { AskMessage } from '@acc/shared';
import { createTestApp, type TestApp } from './helpers.js';

/**
 * Ask reading live data (docs/plans/ASK_READ_ONLY_DATA_PLAN.md) end to end:
 * each answer gets a read-only tool session over the real HTTP tool route,
 * the simulated agent calls it as a real one would over MCP, and the answer
 * lists its lookups. GitHub and Cloudflare are a local stand-in.
 */

class RecordingAdapter extends SimulatedAgentAdapter {
  readonly inputs: AgentExecutionInput[] = [];
  override async execute(input: AgentExecutionInput) {
    this.inputs.push(input);
    return super.execute(input);
  }
}

const ACCOUNT = '0123456789abcdef0123456789abcdef';
let api: http.Server;
let apiBase: string;
const auths: string[] = [];

beforeAll(async () => {
  api = http.createServer((req, res) => {
    auths.push(String(req.headers.authorization));
    const u = new URL(req.url!, 'http://x');
    const json = (value: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (u.pathname === '/gh/user/repos') return json([{ full_name: 'digitronics2025/shop', private: true, default_branch: 'main' }]);
    if (u.pathname === `/cf/accounts/${ACCOUNT}/d1/database`) return json({ success: true, result: [{ uuid: 'u1', name: 'orders' }], result_info: { total_pages: 1 } });
    if (u.pathname.startsWith(`/cf/accounts/${ACCOUNT}/`) && u.pathname.endsWith('/query')) return json({ success: true, result: [{ success: true, results: [{ id: 1, email: 'amina@example.com', total: 12 }], meta: { rows_read: 1 } }] });
    if (u.pathname.startsWith(`/cf/accounts/${ACCOUNT}/`)) return json({ success: true, result: [], result_info: { total_pages: 1 } });
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(() => {
  api.close();
});

let t: TestApp;
let claude: RecordingAdapter;

beforeEach(async () => {
  SimulatedAgentAdapter.reset();
  resetCloudflareCatalog();
  auths.length = 0;
  claude = new RecordingAdapter('claude', 'Claude Code (simulated)', 10);
  t = await createTestApp({
    adapters: [new SimulatedAgentAdapter('codex', 'Codex (simulated)', 10), claude],
    baseEnv: { ...process.env, ACC_GITHUB_API_BASE: `${apiBase}/gh`, ACC_CF_API_BASE: `${apiBase}/cf` },
  });
  // The tool route must be reachable over HTTP, as it is for a real agent's MCP bridge.
  const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
  t.services.tooling.setListenUrl(address);
  (t.services.tooling as unknown as { d: { bridgePath: string } }).d.bridgePath = 'acc-mcp.js';
});

afterEach(async () => {
  await t.close();
});

const clientId = () => `m-${Math.random().toString(36).slice(2)}`;

async function thread(body: Record<string, unknown> = {}): Promise<string> {
  const res = await t.api('POST', '/api/ask/threads', body);
  expect(res.status).toBe(201);
  return res.body.id;
}

async function ask(id: string, text: string): Promise<AskMessage[]> {
  expect((await t.api('POST', `/api/ask/threads/${id}/messages`, { text, clientMessageId: clientId() })).status).toBe(202);
  await t.services.ask.idle(id);
  return (await t.api('GET', `/api/ask/threads/${id}`)).body.messages;
}

async function patchAsk(values: Record<string, unknown>) {
  const current = (await t.api('GET', '/api/settings')).body.ask;
  expect((await t.api('PATCH', '/api/settings', { ask: { ...current, ...values } })).status).toBe(200);
}

async function credential(name: string, kind: string, value: string) {
  expect((await t.api('POST', '/api/credentials', { name, kind, value })).status).toBe(201);
}

describe('Ask data tools', () => {
  it('gives each answer a read-only tool session and lists what it looked up', async () => {
    const id = await thread();
    const messages = await ask(id, 'How many tasks? [sim:lookup:controlcenter.tasks:{"limit":5}]');
    const run = claude.inputs.find((i) => /^Role: ask$/m.test(i.prompt))!;
    expect(run.permissionLevel).toBe(1);
    expect(run.toolBridge?.name).toBe('acc');
    expect(run.prompt).toContain('DATA YOU CAN LOOK AT');
    const answer = messages.at(-1)!;
    expect(answer.body).toContain('controlcenter.tasks: OK');
    expect(answer.lookups).toHaveLength(1);
    expect(answer.lookups[0]).toMatchObject({ capability: 'controlcenter.tasks', status: 'succeeded', live: false });
    // The session ends with the answer: its token no longer works.
    expect(t.services.tools.sessionByToken(run.toolBridge!.env.ACC_TOOL_SESSION)).toBeNull();
  });

  it('refuses everything that is not an allow-listed read, and records the refusal', async () => {
    const id = await thread();
    const messages = await ask(
      id,
      'Try [sim:lookup:fs.write:{"path":"x.txt","content":"y"}] [sim:lookup:shell.run:{"command":"echo hi"}] [sim:lookup:http.request:{"url":"https://example.com"}] [sim:lookup:cloudflare.d1_query:{"database":"orders","sql":"DELETE FROM orders"}] [sim:lookup:github.repos]',
    );
    const answer = messages.at(-1)!;
    for (const cap of ['fs.write', 'shell.run', 'http.request', 'cloudflare.d1_query', 'github.repos']) expect(answer.body).toContain(`${cap}: REFUSED`);
    expect(answer.lookups.map((l) => l.status)).toEqual(['denied', 'denied', 'denied', 'denied', 'denied']);
  });

  it('reads GitHub with exactly the pinned read-only key, never another one', async () => {
    await credential('ask-github-read', 'github', 'pinned-read-token');
    await credential('deploy-github', 'github', 'other-write-token');
    await patchAsk({ sources: { github: { credential: 'ask-github-read', owners: ['digitronics2025'] }, cloudflare: { credential: null, accountId: null } } });
    const id = await thread();
    expect((await t.api('GET', `/api/ask/threads/${id}`)).body.thread.sources).toEqual(['controlcenter', 'github']);
    const messages = await ask(id, 'Which repos? [sim:lookup:github.repos]');
    expect(messages.at(-1)!.body).toContain('github.repos: OK 1 repository');
    expect(auths).toEqual(['Bearer pinned-read-token']);
    // Outside the owner list, refused before any request.
    const outside = await ask(id, 'And [sim:lookup:github.file_read:{"repo":"someone/else","path":"a"}]');
    expect(outside.at(-1)!.body).toContain('github.file_read: REFUSED');
    expect(auths).toHaveLength(1);
  });

  it('a source switched off in the conversation is not reachable, even when set up', async () => {
    await credential('ask-github-read', 'github', 'pinned-read-token');
    await patchAsk({ sources: { github: { credential: 'ask-github-read', owners: ['digitronics2025'] }, cloudflare: { credential: null, accountId: null } } });
    const id = await thread({ sources: ['controlcenter'] });
    const messages = await ask(id, '[sim:lookup:github.repos]');
    expect(messages.at(-1)!.body).toContain('github.repos: REFUSED');
    expect(auths).toHaveLength(0);
  });

  it('masks personal data from live reads unless the conversation shows it', async () => {
    await credential('ask-cf-read', 'cloudflare', 'cf-read-token');
    await patchAsk({ sources: { github: { credential: null, owners: ['digitronics2025'] }, cloudflare: { credential: 'ask-cf-read', accountId: ACCOUNT } } });
    const id = await thread();
    await ask(id, '[sim:lookup:cloudflare.d1_read:{"database":"orders","sql":"SELECT * FROM orders"}]');
    const lookups = (await t.api('GET', `/api/ask/threads/${id}`)).body.messages.at(-1).lookups;
    expect(lookups[0]).toMatchObject({ capability: 'cloudflare.d1_read', status: 'succeeded', live: true });
    // What the agent was given: the call route's text, through the same session scope.
    const scope = { ...(t.services.ask as unknown as { readOnlyScope: (...a: unknown[]) => any }).readOnlyScope('.', null, ['cloudflare'], true), sessionId: null, escalated: new Set<string>() };
    const masked = await t.services.tools.invoke({ capability: 'cloudflare.d1_read', input: { database: 'orders', sql: 'SELECT * FROM orders' }, origin: 'agent', scope });
    expect(JSON.stringify(masked.result.output)).not.toContain('amina@example.com');
    const shown = { ...(t.services.ask as unknown as { readOnlyScope: (...a: unknown[]) => any }).readOnlyScope('.', null, ['cloudflare'], false), sessionId: null, escalated: new Set<string>() };
    const open = await t.services.tools.invoke({ capability: 'cloudflare.d1_read', input: { database: 'orders', sql: 'SELECT * FROM orders' }, origin: 'agent', scope: shown });
    expect(JSON.stringify(open.result.output)).toContain('amina@example.com');
  });

  it('lists and finds only the allow-list in a read-only session', async () => {
    const scope = (t.services.ask as unknown as { readOnlyScope: (...a: unknown[]) => any }).readOnlyScope('.', null, ['controlcenter', 'cloudflare'], true);
    const session = t.services.tools.openSession(scope, 'agent', 60_000);
    const listed = t.services.tools.sessionTools(session).map((x) => x.capability);
    expect(listed.length).toBeGreaterThan(5);
    expect(listed.every((c) => c.startsWith('controlcenter.') || c.startsWith('cloudflare.'))).toBe(true);
    expect(listed).not.toContain('cloudflare.d1_query');
    expect(listed).not.toContain('cloudflare.deploy');
    const found = t.services.tools.find(session, 'write file');
    expect(found).not.toContain('fs.write');
    t.services.tools.closeSession(session.id);
  });

  it('reports usage in dollars with two decimals', async () => {
    const scope = { ...(t.services.ask as unknown as { readOnlyScope: (...a: unknown[]) => any }).readOnlyScope('.', null, ['controlcenter'], true), sessionId: null, escalated: new Set<string>() };
    const r = await t.services.tools.invoke({ capability: 'controlcenter.usage', input: {}, origin: 'agent', scope });
    expect(r.result.ok).toBe(true);
    expect(r.result.summary).toMatch(/: \d+ run\(s\), \$\d+\.\d{2}$/);
  });

  it('stops after the lookup limit for one answer', async () => {
    const id = await thread();
    const many = Array.from({ length: 27 }, () => '[sim:lookup:controlcenter.approvals]').join(' ');
    const messages = await ask(id, many);
    const body = messages.at(-1)!.body;
    expect(body.match(/controlcenter\.approvals: OK/g)).toHaveLength(25);
    expect(body).toContain('REFUSED Lookup limit reached');
  });

  it('checks each source’s access and says what is missing', async () => {
    let checks = (await t.api('POST', '/api/ask/sources/check')).body as Array<{ source: string; ok: boolean; message: string }>;
    expect(checks.find((c) => c.source === 'controlcenter')!.ok).toBe(true);
    expect(checks.find((c) => c.source === 'github')!.message).toContain('Choose a read-only GitHub key');
    await credential('ask-github-read', 'github', 'pinned-read-token');
    await patchAsk({ sources: { github: { credential: 'ask-github-read', owners: ['digitronics2025'] }, cloudflare: { credential: 'missing-key', accountId: ACCOUNT } } });
    checks = (await t.api('POST', '/api/ask/sources/check')).body;
    expect(checks.find((c) => c.source === 'github')).toMatchObject({ ok: true });
    expect(checks.find((c) => c.source === 'cloudflare')!.message).toContain('no longer exists');
    expect((await t.api('GET', '/api/ask/sources')).body.github.ready).toBe(true);
  });

  it('keeps Control Center records on and stores the personal-data switch', async () => {
    const id = await thread();
    const patched = await t.api('PATCH', `/api/ask/threads/${id}`, { sources: ['github'], showPersonal: true });
    expect(patched.body).toMatchObject({ sources: ['controlcenter', 'github'], showPersonal: true });
  });

  it('answers without tools, and says so, when the bridge is off', async () => {
    await t.api('PATCH', '/api/settings', { execution: { ...(await t.api('GET', '/api/settings')).body.execution, exposeToolsToAgents: false } });
    const id = await thread();
    const messages = await ask(id, 'Anything? [sim:lookup:controlcenter.tasks]');
    const run = claude.inputs.at(-1)!;
    expect(run.toolBridge).toBeUndefined();
    expect(run.prompt).toContain('DATA TOOLS: off');
    expect(messages.at(-1)!.body).toContain('No tools for controlcenter.tasks');
  });
});
