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

describe('F-06: READY needs a passing test run after the last change', async () => {
  const { buildFinalReport } = await import('../src/engine/report.js');
  const at = (m: number) => new Date(Date.UTC(2026, 8, 24, 12, m)).toISOString();
  const stage = (id: string, role: string, kind: string, status: string, m: number) => ({ id, role, kind, status, createdAt: at(m), name: id, summary: null, verdict: null, errorMessage: null }) as never;
  const run = (stageId: string, status: string) => ({ id: `${stageId}-run`, stageId, kind: 'test', name: 'test', status, durationMs: 1, summary: null }) as never;
  const task = {
    id: 'TASK-0001', title: 'x', description: 'x', mode: 'autopilot', supervised: false, fixCycles: 0, maxFixCycles: 3, recoveryCycle: 0,
    git: { baselineBranch: 'main', baselineCommit: null, taskBranch: null, isolated: false, commits: [] }, workflow: { name: 'W', stages: [{ key: 'test', kind: 'tests' }] },
  } as never;
  const repo = { name: 'r', path: '/r' } as never;
  const report = (stages: never[], testRuns: never[]) => buildFinalReport({ task, repo, stages, testRuns, files: [], testsSkipped: false, deployed: 'none' });

  it('is READY when the last finished test stage passed after the last write', () => {
    expect(report([stage('impl', 'implementer', 'agent', 'SUCCESS', 1), stage('t1', 'tester', 'tests', 'SUCCESS', 2)], [run('t1', 'passed')]).finalStatus).toBe('READY');
  });

  it('ignores a cancelled test instance and asks for action when no run finished after the change', () => {
    const r = report([stage('impl', 'implementer', 'agent', 'SUCCESS', 1), stage('t1', 'tester', 'tests', 'CANCELLED', 2)], [run('t1', 'not_run')]);
    expect(r.finalStatus).toBe('NEEDS_USER_ACTION');
    expect(r.limitations).toContain('No test stage ran.');
  });

  it('asks for action when a fixer changed files after the last passing run', () => {
    const r = report([stage('impl', 'implementer', 'agent', 'SUCCESS', 1), stage('t1', 'tester', 'tests', 'SUCCESS', 2), stage('fix', 'fixer', 'agent', 'SUCCESS', 3)], [run('t1', 'passed')]);
    expect(r.finalStatus).toBe('NEEDS_USER_ACTION');
    expect(r.limitations).toContain('Tests have not run since the last change.');
  });

  it('asks for action when the last run passed nothing', () => {
    const r = report([stage('impl', 'implementer', 'agent', 'SUCCESS', 1), stage('t1', 'tester', 'tests', 'SUCCESS', 2)], [run('t1', 'not_run')]);
    expect(r.finalStatus).toBe('NEEDS_USER_ACTION');
  });
});
