import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import type { AskMessage } from '@acc/shared';
import { createTestApp, type TestApp } from './helpers.js';

/**
 * Ask against the real Cloudflare and GitHub APIs, end to end through a
 * read-only tool session (docs/plans/ASK_READ_ONLY_DATA_PLAN.md §7.3). Skipped
 * unless ACC_LIVE_DATA=1. It runs in a throwaway orchestrator (a temporary data
 * folder, deleted afterwards): the keys in this process's environment are
 * sealed into that folder's own credential store, never the live one, never
 * MyVault, and never printed.
 *
 *   ACC_LIVE_DATA=1 GH_TOKEN=… CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     pnpm --filter @acc/orchestrator exec vitest run test/ask-live.test.ts
 */

const live = process.env.ACC_LIVE_DATA === '1';
const cf = { token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID };
const gh = process.env.GH_TOKEN;

let t: TestApp;

async function ask(id: string, text: string): Promise<AskMessage> {
  expect((await t.api('POST', `/api/ask/threads/${id}/messages`, { text, clientMessageId: `m-${Math.random().toString(36).slice(2)}` })).status).toBe(202);
  await t.services.ask.idle(id);
  const messages: AskMessage[] = (await t.api('GET', `/api/ask/threads/${id}`)).body.messages;
  const answer = messages.at(-1)!;
  for (const line of answer.body.split('\n').filter((l) => l.startsWith('- ') && l.includes('.'))) console.log(`ask › ${line.slice(2, 220)}`);
  return answer;
}

describe.skipIf(!live || !cf.token || !cf.account || !gh)('Ask with real data (live)', () => {
  beforeAll(async () => {
    SimulatedAgentAdapter.reset();
    t = await createTestApp();
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    t.services.tooling.setListenUrl(address);
    (t.services.tooling as unknown as { d: { bridgePath: string } }).d.bridgePath = 'acc-mcp.js';
    await t.services.credentials.create({ name: 'ask-cloudflare-read', kind: 'cloudflare', envVar: null, description: 'live test', repositoryIds: null, value: cf.token! });
    await t.services.credentials.create({ name: 'ask-github-read', kind: 'github', envVar: null, description: 'live test', repositoryIds: null, value: gh! });
    const current = (await t.api('GET', '/api/settings')).body.ask;
    const res = await t.api('PATCH', '/api/settings', { ask: { ...current, sources: { github: { credential: 'ask-github-read', owners: ['digitronics2025'] }, cloudflare: { credential: 'ask-cloudflare-read', accountId: cf.account } } } });
    expect(res.status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    const dir = t?.dataDir;
    await t?.close();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  it('checks access per source', async () => {
    const checks = (await t.api('POST', '/api/ask/sources/check')).body as Array<{ source: string; ok: boolean; message: string }>;
    for (const c of checks) console.log(`check › ${c.source}: ${c.ok ? 'ok' : 'not ok'} — ${c.message.slice(0, 160)}`);
    expect(checks.find((c) => c.source === 'controlcenter')!.ok).toBe(true);
    expect(checks.find((c) => c.source === 'cloudflare')!.ok).toBe(true);
  }, 120_000);

  it('reads live Cloudflare data through the session, and refuses a write before it is sent', async () => {
    const id = (await t.api('POST', '/api/ask/threads', {})).body.id;
    const answer = await ask(
      id,
      'Live check [sim:lookup:cloudflare.catalog] [sim:lookup:cloudflare.d1_read:{"database":"acc-control-production","sql":"SELECT COUNT(*) AS n FROM sqlite_schema"}] [sim:lookup:cloudflare.d1_read:{"database":"acc-control-production","sql":"DELETE FROM nodes"}] [sim:lookup:cloudflare.d1_query:{"database":"acc-control-production","sql":"SELECT 1","environment":"production"}]',
    );
    expect(answer.body).toMatch(/cloudflare\.catalog: OK \d+ D1 database/);
    expect(answer.body).toMatch(/cloudflare\.d1_read: OK D1 acc-control-production: 1 row/);
    expect(answer.body).toContain('cloudflare.d1_read: REFUSED');
    expect(answer.body).toContain('cloudflare.d1_query: REFUSED');
    // Only reads that happened are live data; the two refusals read nothing.
    expect(answer.lookups.filter((l) => l.live).map((l) => l.capability)).toEqual(['cloudflare.catalog', 'cloudflare.d1_read']);
  }, 180_000);

  it('refuses a GitHub key that can write, on every call', async () => {
    const id = (await t.api('POST', '/api/ask/threads', {})).body.id;
    const answer = await ask(id, 'Live check [sim:lookup:github.repos]');
    // This machine's own GitHub login is a classic token with write scopes: Ask must not use it.
    expect(answer.body).toMatch(/github\.repos: REFUSED .*can change repositories/);
  }, 180_000);
});
