import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSelfReferences } from '@acc/security';
import type { ToolScope } from '../src/tools/service.js';
import { createTestApp, type TestApp } from './helpers.js';

/**
 * Regression tests for the 2026-09-24 pre-release audit
 * (docs/security/prerelease-audit-2026-09-24.md). Each test names its finding.
 */

let t: TestApp;
let work: string;

beforeAll(async () => {
  t = await createTestApp();
  work = mkdtempSync(path.join(os.tmpdir(), 'acc-audit-'));
  setSelfReferences({ dataDir: t.dataDir, port: 4317 });
});
afterAll(async () => {
  setSelfReferences({});
  await t.close();
});

function scope(overrides: Partial<ToolScope> = {}): ToolScope {
  return {
    taskId: null,
    stageId: null,
    sessionId: null,
    repositoryId: null,
    cwd: work,
    roots: [work],
    stageLevel: 4,
    autoApproveUpToLevel: 4,
    mode: 'full',
    profile: 'operator',
    escalated: new Set(),
    protectedPaths: [],
    ...overrides,
  };
}

describe('F-02: an agent cannot reach the Control Center itself through any tool', () => {
  it.each([
    ['http.request', { method: 'POST', url: 'http://127.0.0.1:4317/api/approvals/x/approve' }],
    ['http.request', { method: 'GET', url: 'http://localhost:4317/' }],
    ['web.read', { url: 'http://127.0.0.1:4317/' }],
    ['shell.run', { script: 'Get-Content "$env:LOCALAPPDATA\\AIDevControlCenter\\auth-token"' }],
  ])('%s %j is denied before it runs', async (capability, input) => {
    const outcome = await t.services.tools.invoke({ capability, input, origin: 'agent', scope: scope() });
    expect(outcome.decision).toBe('deny');
    expect(outcome.result.summary).toMatch(/Control Center's own token, data folder or API/);
    expect(outcome.execution.status).toBe('denied');
  });

  it('names the actual data folder too', async () => {
    const outcome = await t.services.tools.invoke({ capability: 'shell.run', input: { script: `dir "${path.join(t.dataDir, 'tasks')}"` }, origin: 'agent', scope: scope() });
    expect(outcome.decision).toBe('deny');
  });

  it('leaves an ordinary loopback app alone', async () => {
    const outcome = await t.services.tools.invoke({ capability: 'http.request', input: { method: 'GET', url: 'http://127.0.0.1:9/' }, origin: 'agent', scope: scope() });
    expect(outcome.decision).not.toBe('deny');
  });
});

describe('F-54: switching to API billing needs the typed phrase on the server', () => {
  it('refuses the bare patch, accepts the phrase, and needs nothing to switch back', async () => {
    const bare = await t.api('PATCH', '/api/settings', { billingMode: 'api' });
    expect(bare.status).toBe(422);
    expect(bare.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect((await t.api('GET', '/api/settings')).body.billingMode).toBe('subscription');
    expect((await t.api('PATCH', '/api/settings', { billingMode: 'api', confirmation: 'api billing' })).status).toBe(422);
    const typed = await t.api('PATCH', '/api/settings', { billingMode: 'api', confirmation: 'API BILLING' });
    expect(typed.status).toBe(200);
    expect(typed.body.billingMode).toBe('api');
    expect(typed.body).not.toHaveProperty('confirmation');
    const back = await t.api('PATCH', '/api/settings', { billingMode: 'subscription' });
    expect(back.body.billingMode).toBe('subscription');
  });
});
