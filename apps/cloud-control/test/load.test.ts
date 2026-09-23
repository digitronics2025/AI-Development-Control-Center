/** The node link under bursts of concurrent reads, like a dashboard page opening (docs/systems/cloud-control.md §Hub). */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, waitFor, type TestApp } from '../../orchestrator/test/helpers.js';
import { startCloud, type Cloud } from './harness.js';

let cloud: Cloud;
let node: TestApp;
beforeAll(async () => {
  cloud = await startCloud({});
  node = await createTestApp();
  const code = (await cloud.api('POST', '/api/cloud/pairing-tokens', { label: 's' })).body.token;
  await node.services.remote.pair({ relayUrl: cloud.url, code, label: 'stress' });
  await waitFor(() => node.services.remote.status().state, (s) => s === 'connected', 30_000);
});
afterAll(async () => {
  await node?.close();
  await cloud?.stop();
});

it('stays connected under bursts of concurrent reads', async () => {
  const closes: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { closes.push(String(a[0])); orig(...a); };
  const from = new Date(Date.now() - 30 * 86400_000).toISOString();
  const to = new Date().toISOString();
  const paths = ['/api/health', '/api/overview', '/api/agents', '/api/repositories', '/api/settings', '/api/tools', `/api/usage/overview?from=${from}&to=${to}`, `/api/usage/trend?from=${from}&to=${to}`, `/api/usage/events?from=${from}&to=${to}&limit=50`, '/api/workflows', '/api/tasks?limit=50', '/api/approvals'];
  const statuses: Record<number, number> = {};
  for (let round = 0; round < 10; round++) {
    const results = await Promise.all(paths.map((p) => cloud.api('GET', p)));
    for (const r of results) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  }
  console.warn = orig;
  expect(closes).toEqual([]);
  expect(Object.keys(statuses)).toEqual(['200']);
});
