import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newId, now } from '../src/store/store.js';
import { addRepo, createTask, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from './helpers.js';

/** Targeted baseline runs (docs/plans/LEAD_TIME_PLAN.md §3.1). */

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

/**
 * A stand-in for Vitest, committed with its node_modules/.bin shims so the
 * baseline worktree needs no install. It prints a Vitest FAIL line for each
 * failing test in the files it is given (every file when given none), hangs
 * when asked for slow.test.ts, fails c.test.ts while the FAKE_NIGHT file exists
 * (a test that depends on the time of day), and exits 1 when anything failed.
 */
const FAKE_VITEST = [
  "const files = process.argv.slice(2).filter((a) => a !== 'run');",
  "if (files.includes('slow.test.ts')) setTimeout(() => {}, 120000);",
  "else {",
  "  const night = process.env.FAKE_NIGHT && require('fs').existsSync(process.env.FAKE_NIGHT);",
  "  const failing = { 'a.test.ts': ['a.test.ts > A > one'], 'b.test.ts': ['b.test.ts > B > two'], 'c.test.ts': night ? ['c.test.ts > C > at night'] : [] };",
  "  const ran = files.length ? files : Object.keys(failing);",
  "  const failed = ran.flatMap((f) => failing[f] || []);",
  "  for (const f of failed) console.log(' FAIL  ' + f);",
  "  console.log(' Tests  ' + failed.length + ' failed | 5 passed');",
  "  process.exit(failed.length ? 1 : 0);",
  "}",
].join('\n');

async function fixture(app: TestApp) {
  const gitLib = await import('@acc/git');
  const repoPath = await makeRepo({ scripts: { test: 'vitest run' }, files: { 'fake-vitest.js': FAKE_VITEST, 'a.test.ts': '', 'b.test.ts': '', 'c.test.ts': '', 'slow.test.ts': '' } });
  const bin = path.join(repoPath, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'vitest.cmd'), '@node "%~dp0\\..\\..\\fake-vitest.js" %*\r\n');
  writeFileSync(path.join(bin, 'vitest'), '#!/bin/sh\nexec node "$(dirname "$0")/../../fake-vitest.js" "$@"\n');
  await gitLib.git(repoPath, ['add', '-f', 'node_modules']);
  await gitLib.git(repoPath, ['update-index', '--chmod=+x', 'node_modules/.bin/vitest']);
  await gitLib.git(repoPath, ['commit', '-m', 'fake runner']);
  const repo = await addRepo(app, repoPath);
  const id = await createTask(app, repo, 'Probe', { start: false });
  const { store, bus, tooling } = app.services;
  const { BaselineChecks } = await import('../src/engine/baseline-checks.js');
  const checks = new BaselineChecks({ store, bus, tooling, dataDir: app.dataDir });
  const head = (await gitLib.headCommit(repoPath))!;
  const command = { id: 'test', name: 'unit tests', command: 'npm test', kind: 'test' as const, enabled: true, timeoutSec: 60 };
  const base = { task: store.getTask(id)!, stage: { id: 'stage-x', createdAt: new Date().toISOString() } as never, repo: store.getRepository(repo)!, baselineCommit: head, command, env: process.env, overflow: false };
  const baselineRuns = () => store.listExecutions(id).filter((e) => e.command.startsWith('baseline ')).map((e) => e.command);
  const fullKey = { repositoryId: repo, baselineCommit: head, commandId: 'test', commandSha: BaselineChecks.commandSha('npm test') };
  return { checks, base, command, baselineRuns, fullKey, store, stopped: { stopped: () => false } };
}

describe('targeted baseline runs', () => {
  it('proves a failure pre-existing by running only its file, and never stands in for the full run', async () => {
    t = await createTestApp();
    const f = await fixture(t);
    const verdict = await f.checks.classify({ ...f.base, failures: ['a.test.ts > A > one'] }, f.stopped);
    expect(verdict).toMatchObject({ classification: 'preexisting', checkedFiles: 1 });
    expect(f.baselineRuns()).toEqual([expect.stringMatching(/: npm test -- a\.test\.ts$/)]);
    // The narrowed result is kept under its own key: a later full lookup finds nothing.
    expect(f.store.getBaselineCheck(f.fullKey)).toBeNull();
    // Asked again, the kept narrowed result answers without running anything.
    expect((await f.checks.classify({ ...f.base, failures: ['a.test.ts > A > one'] }, f.stopped)).classification).toBe('preexisting');
    expect(f.baselineRuns()).toHaveLength(1);
  }, 90_000);

  it('falls back to exactly one full run when a failure does not reproduce, and the full answer stands', async () => {
    t = await createTestApp();
    const f = await fixture(t);
    const verdict = await f.checks.classify({ ...f.base, failures: ['a.test.ts > A > one', 'c.test.ts > C > broke'] }, f.stopped);
    expect(verdict.classification).toBe('new');
    expect(verdict.checkedFiles).toBeUndefined();
    const runs = f.baselineRuns();
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatch(/npm test -- a\.test\.ts c\.test\.ts$/);
    expect(runs[1]).toMatch(/: npm test$/);
    // What the full run does not explain runs once more, now: it still passes there, so it stays new.
    expect(runs[2]).toMatch(/: npm test -- c\.test\.ts$/);
    // Now the full answer is known, and it is used first: nothing more runs.
    expect(f.store.getBaselineCheck(f.fullKey)?.status).toBe('failed');
    expect((await f.checks.classify({ ...f.base, failures: ['b.test.ts > B > two'] }, f.stopped)).classification).toBe('preexisting');
    expect(f.baselineRuns()).toHaveLength(3);
  }, 90_000);

  it('goes straight to the full run when a failing file did not exist on the baseline', async () => {
    t = await createTestApp();
    const f = await fixture(t);
    const verdict = await f.checks.classify({ ...f.base, failures: ['a.test.ts > A > one', 'added.test.ts > new'] }, f.stopped);
    expect(verdict.classification).toBe('new');
    expect(f.baselineRuns()).toEqual([expect.stringMatching(/: npm test$/)]);
  }, 90_000);

  it('falls back to the full run when the narrowed run cannot finish', async () => {
    t = await createTestApp();
    const f = await fixture(t);
    const slow = { ...f.command, timeoutSec: 4 };
    const verdict = await f.checks.classify({ ...f.base, command: slow, failures: ['slow.test.ts > S > hangs'] }, f.stopped);
    // The narrowed run timed out; the full run finished and does not show that failure.
    expect(verdict.classification).toBe('new');
    const runs = f.baselineRuns();
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatch(/npm test -- slow\.test\.ts$/);
    expect(runs[1]).toMatch(/: npm test$/);
    expect(runs[2]).toMatch(/npm test -- slow\.test\.ts$/);
  }, 90_000);

  it('checks again, now, what a kept full run does not explain: a test that depends on the time of day (TASK-0010)', async () => {
    t = await createTestApp();
    const f = await fixture(t);
    const marker = path.join(t.dataDir, 'night');
    const input = { ...f.base, env: { ...process.env, FAKE_NIGHT: marker }, failures: ['a.test.ts > A > one', 'c.test.ts > C > at night'] };
    // In the afternoon the baseline passes c.test.ts: the failure is new, and the full run is kept.
    expect((await f.checks.classify(input, f.stopped)).classification).toBe('new');
    expect(f.store.getBaselineCheck(f.fullKey)?.failures).toEqual(['a.test.ts > A > one', 'b.test.ts > B > two']);
    const before = f.baselineRuns().length;
    // At night the same test fails on the baseline too: the kept answer is out of date, so c.test.ts runs again now.
    writeFileSync(marker, '');
    expect(await f.checks.classify(input, f.stopped)).toMatchObject({ classification: 'preexisting', checkedFiles: 1 });
    const after = f.baselineRuns();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatch(/: npm test -- c\.test\.ts$/);
  }, 90_000);
});

/** A kept result of `commandId` on an older commit of the repository: the history a warm-up is decided from. */
const keptBefore = (app: TestApp, repositoryId: string, commandId: string, commandSha: string, over: { status?: 'passed' | 'failed'; durationMs?: number; createdAt?: string; commit?: string } = {}) =>
  app.services.store.saveBaselineCheck({
    id: newId(),
    repositoryId,
    baselineCommit: over.commit ?? '0'.repeat(40),
    commandId,
    commandSha,
    status: over.status ?? 'failed',
    summary: null,
    failures: over.status === 'passed' ? [] : ['old > failure'],
    durationMs: over.durationMs ?? 1000,
    createdAt: over.createdAt ?? now(),
  });
const failedBefore = (app: TestApp, repositoryId: string, commandId: string, commandSha: string) => keptBefore(app, repositoryId, commandId, commandSha);
/** Plenty of time before the command would start anyway, and its own typical duration known. */
const ROOMY = { headStartMs: 60_000, typicalRunMs: 1000 };

describe('warming a baseline before anything failed (TASK-0014)', () => {
  it('warms only when the command failed on a baseline before, and a failure meanwhile waits for that run instead of starting another', async () => {
    t = await createTestApp();
    const f = await fixture(t);
    // No failing history: nothing is warmed.
    expect(f.checks.warm(f.base, ROOMY)).toBeNull();
    expect(f.baselineRuns()).toHaveLength(0);
    failedBefore(t, f.fullKey.repositoryId, 'test', f.fullKey.commandSha);
    const warm = f.checks.warm(f.base, ROOMY);
    expect(warm).not.toBeNull();
    // A failure while the warm-up runs is classified from its result: no narrowed run, no second full run.
    const verdict = await f.checks.classify({ ...f.base, failures: ['a.test.ts > A > one'] }, f.stopped);
    expect(verdict).toMatchObject({ classification: 'preexisting' });
    expect(verdict.checkedFiles).toBeUndefined();
    expect((await warm!.done)?.status).toBe('failed');
    expect(f.baselineRuns()).toEqual([expect.stringMatching(/: npm test$/)]);
    // The answer is kept for this commit: nothing more to warm.
    expect(f.checks.warm(f.base, ROOMY)).toBeNull();
  }, 90_000);

  it('warms nothing when a result is already kept at this commit, even one of only the failing files', async () => {
    t = await createTestApp();
    const f = await fixture(t);
    failedBefore(t, f.fullKey.repositoryId, 'test', f.fullKey.commandSha);
    f.store.saveBaselineCheck({ ...f.fullKey, commandSha: 'narrowed-sha', id: newId(), status: 'failed', summary: null, failures: ['a.test.ts > A > one'], durationMs: 1, createdAt: now() });
    expect(f.checks.warm(f.base, ROOMY)).toBeNull();
    // A kept attempt that could not run proves nothing: that one does not count.
    f.store.saveBaselineCheck({ ...f.fullKey, commandSha: 'narrowed-sha', id: newId(), status: 'error', summary: 'could not run', failures: [], durationMs: 1, createdAt: now() });
    const warm = f.checks.warm(f.base, ROOMY);
    expect(warm).not.toBeNull();
    await warm!.done;
  }, 90_000);

  it('follows the newest result that says whether the command fails there, not any failure ever kept', async () => {
    t = await createTestApp();
    const f = await fixture(t);
    const { repositoryId, commandSha } = f.fullKey;
    const at = (day: number) => `2026-09-${day}T12:00:00.000Z`;
    // It failed on an old baseline, then passed on a newer one (the suite was fixed): nothing to warm.
    keptBefore(t, repositoryId, 'test', commandSha, { commit: 'a'.repeat(40), createdAt: at(20) });
    keptBefore(t, repositoryId, 'test', commandSha, { commit: 'b'.repeat(40), createdAt: at(21), status: 'passed' });
    expect(f.checks.warm(f.base, ROOMY)).toBeNull();
    // Only some files passing on a later baseline says nothing about the rest of the suite.
    keptBefore(t, repositoryId, 'test', 'narrowed-pass', { commit: 'c'.repeat(40), createdAt: at(22), status: 'passed' });
    expect(f.checks.warm(f.base, ROOMY)).toBeNull();
    expect(f.baselineRuns()).toHaveLength(0);
    // Some files failing on a later baseline fail the whole suite there: warmed again.
    keptBefore(t, repositoryId, 'test', 'narrowed-fail', { commit: 'd'.repeat(40), createdAt: at(23) });
    const warm = f.checks.warm(f.base, ROOMY);
    expect(warm).not.toBeNull();
    // Its own result is kept and is now the newest one, so a warm-up that passed would end warming by itself.
    expect((await warm!.done)?.status).toBe('failed');
    expect(f.store.getBaselineCheck(f.fullKey)?.status).toBe('failed');
  }, 90_000);

  it('warms only when it is expected to end before the command would start anyway', async () => {
    t = await createTestApp();
    const f = await fixture(t);
    const { repositoryId, commandSha } = f.fullKey;
    const clear = () => f.store.db.prepare('DELETE FROM baseline_checks').run();
    // A whole run took 5 s: the checks before the command must typically take at least that long.
    keptBefore(t, repositoryId, 'test', commandSha, { durationMs: 5000 });
    expect(f.checks.warm(f.base, { headStartMs: 4999, typicalRunMs: null })).toBeNull();
    // Only a run of the failing files kept (1 s: its worktree, install and those files): that plus the command's typical duration.
    clear();
    keptBefore(t, repositoryId, 'test', 'narrowed-fail', { durationMs: 1000 });
    expect(f.checks.warm(f.base, { headStartMs: 60_000, typicalRunMs: null })).toBeNull();
    expect(f.checks.warm(f.base, { headStartMs: 3999, typicalRunMs: 3000 })).toBeNull();
    expect(f.baselineRuns()).toHaveLength(0);
    const narrowed = f.checks.warm(f.base, { headStartMs: 4000, typicalRunMs: 3000 });
    expect(narrowed?.expectedMs).toBe(4000);
    await narrowed!.done;
    clear();
    keptBefore(t, repositoryId, 'test', commandSha, { durationMs: 5000 });
    const whole = f.checks.warm(f.base, { headStartMs: 5000, typicalRunMs: null });
    expect(whole?.expectedMs).toBe(5000);
    await whole!.done;
  }, 90_000);

  it('stops a warm-up the stage no longer needs, while its command runs', async () => {
    t = await createTestApp();
    const f = await fixture(t);
    const slow = { ...f.command, id: 'slow', command: 'npm test -- slow.test.ts' };
    failedBefore(t, f.fullKey.repositoryId, 'slow', 'any-sha');
    const warm = f.checks.warm({ ...f.base, command: slow }, ROOMY)!;
    const exec = await waitFor(() => f.store.listExecutions(f.base.task.id).find((e) => e.command.startsWith('baseline ')), (e) => Boolean(e), 30_000, 'the warm-up to start');
    // The command itself is running (its line is logged, and the flushed log shows it), not the worktree setup.
    await waitFor(() => f.store.listLogLines(exec!.id).map((l) => l.text), (lines) => lines.some((l) => l.startsWith('$ npm test')), 30_000, 'the baseline command to start');
    await new Promise((r) => setTimeout(r, 1500));
    const started = Date.now();
    warm.cancel();
    const record = await warm.done;
    // Stopped, not left to its 60 s timeout; kept as an error, which is always tried again.
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(record).toMatchObject({ status: 'error' });
    expect(record!.summary).toMatch(/stopped/i);
  }, 90_000);
});

describe('the tests stage warms the e2e baseline (TASK-0014)', () => {
  /** A stand-in e2e suite with one failure that the baseline has too; it takes a moment, like a browser run. */
  const FAKE_E2E = "setTimeout(() => { console.log(' FAIL  e2e/home.spec.ts > home > loads'); console.log(' Tests  1 failed | 3 passed'); process.exit(1); }, 1500);";
  const E2E_ONLY = { id: 'e2e-check', name: 'E2E check', stages: [{ key: 'test', name: 'Test', role: 'tester', kind: 'tests', permissionLevel: 2, next: 'complete', commandKinds: ['test', 'e2e'] }] };

  const UNIT = `node -e "console.log('1 passed')"`;

  /** `unitTypicalMs`: how long the unit check typically took in an earlier task (the kept failure of the e2e baseline took 1 s). */
  async function e2eTask({ history, e2eOnly = false, unitTypicalMs = 3000, parallel = false }: { history: boolean; e2eOnly?: boolean; unitTypicalMs?: number; parallel?: boolean }) {
    t = await createTestApp();
    expect((await t.api('PUT', `/api/workflows/${E2E_ONLY.id}`, E2E_ONLY)).status).toBe(200);
    const repoPath = await makeRepo({ files: { 'fake-e2e.js': FAKE_E2E } });
    const repoId = await addRepo(t, repoPath, {
      preexistingFailures: 'allow',
      commands: [
        { id: 'unit', name: 'unit', command: UNIT, kind: 'test', enabled: !e2eOnly, timeoutSec: 60, parallelSafe: parallel },
        { id: 'e2e', name: 'e2e', command: 'node fake-e2e.js', kind: 'e2e', enabled: true, timeoutSec: 60, parallelSafe: parallel },
      ],
    });
    const { BaselineChecks } = await import('../src/engine/baseline-checks.js');
    if (history) failedBefore(t, repoId, 'e2e', BaselineChecks.commandSha('node fake-e2e.js'));
    const earlier = await createTask(t, repoId, 'An earlier task', { start: false });
    const at = new Date(Date.now() - 60_000).toISOString();
    t.services.store.insertTestRun({ id: newId(), taskId: earlier, stageId: null, executionId: null, name: 'unit', kind: 'test', command: UNIT, status: 'passed', exitCode: 0, durationMs: unitTypicalMs, summary: '1 passed', startedAt: at, finishedAt: at });
    const id = await createTask(t, repoId, 'Check the e2e suite', { workflowId: E2E_ONLY.id, supervised: false });
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    const cmds = t.services.store.listExecutions(id).filter((e) => e.kind === 'command');
    const ms = (iso: string | null) => new Date(iso!).getTime();
    return {
      task,
      baseline: cmds.filter((e) => e.command.startsWith('baseline ')),
      unit: cmds.find((e) => e.command.includes('1 passed')),
      e2e: cmds.find((e) => e.command === 'node fake-e2e.js')!,
      e2eRun: t.services.store.listTestRuns(id).find((r) => r.name === 'e2e')!,
      events: t.services.store.listEvents(id, { limit: 500 }),
      ms,
    };
  }

  it('starts the e2e baseline with the stage when history predicts it; the e2e waits for it and its failure needs no second run', async () => {
    const r = await e2eTask({ history: true });
    expect(r.task.status).toBe('COMPLETED');
    expect(r.baseline).toHaveLength(1);
    const [warm] = r.baseline;
    // Started with the stage, beside the unit check, before any failure.
    expect(r.ms(warm!.startedAt)).toBeLessThanOrEqual(r.ms(r.unit!.startedAt));
    // The task's own e2e started only after the warm-up ended (a fixed port with reuseExistingServer).
    expect(r.ms(r.e2e.startedAt)).toBeGreaterThanOrEqual(r.ms(warm!.finishedAt));
    // Expected from the kept whole run (1 s), against the unit check's typical 3 s before it.
    expect(r.events.find((e) => e.data?.baselineWarmup === 'e2e')?.data).toMatchObject({ expectedMs: 1000, headStartMs: 3000 });
    expect(r.events.some((e) => e.data?.waitingFor === 'baseline')).toBe(true);
    // Classified from the warmed result.
    expect(r.e2eRun).toMatchObject({ status: 'failed', classification: 'preexisting' });
  }, 90_000);

  it.each([
    ['without a failing history', { history: false }],
    ['when nothing runs before the e2e (it would only wait)', { history: true, e2eOnly: true }],
    ['when the checks before it typically end sooner than the baseline run (the e2e would wait)', { history: true, unitTypicalMs: 500 }],
    ['when the check before it runs in the same parallel batch (it starts with the e2e)', { history: true, parallel: true }],
  ])('warms nothing %s: the baseline runs after the e2e failed, as before', async (_why, opts) => {
    const r = await e2eTask(opts);
    expect(r.task.status).toBe('COMPLETED');
    expect(r.baseline).toHaveLength(1);
    expect(r.ms(r.baseline[0]!.startedAt)).toBeGreaterThanOrEqual(r.ms(r.e2e.finishedAt));
    expect(r.events.some((e) => e.data?.baselineWarmup || e.data?.waitingFor)).toBe(false);
    expect(r.e2eRun).toMatchObject({ status: 'failed', classification: 'preexisting' });
  }, 90_000);
});
