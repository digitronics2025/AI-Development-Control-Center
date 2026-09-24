import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSelfReferences } from '@acc/security';
import { preflightFindings, withoutSensitiveFiles } from '../src/source-control/preflight.js';
import type { ToolScope } from '../src/tools/service.js';
import { addRepo, createTask, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from './helpers.js';

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

describe('F-09: an approval for a stage the workflow always asks about covers one attempt', () => {
  it('asks again when the approved staging deploy runs a second time', async () => {
    const repoId = await addRepo(t, await makeRepo({ scripts: { test: 'node -e "0"' } }));
    const repo = (await t.api('GET', `/api/repositories/${repoId}`)).body;
    await t.api('PATCH', `/api/repositories/${repoId}`, {
      commands: [
        ...repo.commands,
        { id: 'staging', name: 'staging deploy', command: 'node -e "console.log(1)"', kind: 'deploy-staging', enabled: true, timeoutSec: 60 },
        { id: 'smoke', name: 'smoke', command: 'node -e "process.exit(1)"', kind: 'smoke', enabled: true, timeoutSec: 60 },
      ],
    });
    const id = await createTask(t, repoId, 'Ship it twice', { workflowId: 'full-autopilot' });
    await waitForStatus(t, id, ['WAITING_FOR_USER']);
    const pendingFor = async () => (await t.api('GET', '/api/approvals?status=pending')).body.filter((a: { taskId: string }) => a.taskId === id);
    const [first] = await pendingFor();
    expect(first).toMatchObject({ kind: 'stage_permission', stageKey: 'staging' });
    await t.api('POST', `/api/approvals/${first.id}/approve`, {});
    await waitFor(() => t.services.store.latestStage(id, 'staging'), (s) => s?.status === 'SUCCESS', 60_000);
    // The smoke test fails and the task stops; running staging again is a second deploy and must
    // wait for a second yes.
    await waitForStatus(t, id, ['FAILED', 'WAITING_FOR_USER'], 60_000);
    expect((await t.api('POST', `/api/tasks/${id}/retry`, { stageKey: 'staging' })).status).toBeLessThan(300);
    const again = await waitFor(pendingFor, (list) => list.some((a: { id: string; stageKey: string }) => a.id !== first.id && a.stageKey === 'staging'), 60_000);
    expect(again.length).toBe(1);
    expect(t.services.store.listStages(id).filter((s) => s.stageKey === 'staging' && s.status === 'SUCCESS')).toHaveLength(1);
    await t.api('POST', `/api/tasks/${id}/cancel`);
  }, 120_000);
});

describe('F-11: an agent a crash left running is stopped before the task resumes', () => {
  it('kills a leftover execution whose pid still belongs to that run, and leaves a reused pid alone', async () => {
    const { spawn } = await import('node:child_process');
    const { processAlive } = await import('../src/chairman/watchdog.js');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    const startedAt = new Date().toISOString();
    // A recorded start an hour off is another program that reused the pid: never killed.
    expect(await t.services.processes.stopLeftoverExecutions([{ pid, startedAt: new Date(Date.now() - 3_600_000).toISOString() }])).toBe(0);
    expect(processAlive(pid)).toBe(true);
    expect(await t.services.processes.stopLeftoverExecutions([{ pid, startedAt }, { pid: null, startedAt }])).toBe(1);
    await waitFor(() => processAlive(pid), (alive) => !alive, 15_000);
  }, 60_000);
});

describe('F-47: the secret preflight reads every file header', () => {
  it('checks added lines under a quoted or unreadable name, and keeps unreadable names out of AI context', () => {
    const secret = ['gh', 'p_', 'C'.repeat(36)].join('');
    const quoted = ['diff --git "a/we\\"ird.ts" "b/we\\"ird.ts"', 'new file mode 100644', '@@ -0,0 +1 @@', `+const t = "${secret}";`].join('\n');
    expect(preflightFindings([], quoted)).toEqual([{ path: 'we"ird.ts', reason: expect.stringContaining('GitHub token') }]);
    const odd = ['diff --git no-sides-here', '@@ -0,0 +1 @@', `+${secret}`].join('\n');
    expect(preflightFindings([], odd)).toHaveLength(1);
    expect(withoutSensitiveFiles(odd).patch).not.toContain(secret);
  });
});
