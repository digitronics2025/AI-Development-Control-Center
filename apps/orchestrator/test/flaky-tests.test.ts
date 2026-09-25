import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '@acc/git';
import { addRepo, createTask, createTestApp, makeRepo, waitForStatus, type TestApp } from './helpers.js';

/**
 * Flaky tests: a failure the baseline does not explain gets its failing test
 * files run once more on exactly the task's files. All passing → `flaky`,
 * reported and not blocking; failing again → it stays a failure. Found in
 * TASK-0009 (docs-only change, a different one-in-9269 test failing each run).
 */

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

/**
 * A stand-in for Vitest committed with its shims. After the task's change
 * (sim-output.md exists) the whole-suite run fails `a.test.ts`; run on its own,
 * `a.test.ts` passes when `mode` is "flaky" and fails again when it is "real".
 * On the baseline (no sim-output.md) everything passes, so the failure is new.
 */
const fakeVitest = (mode: 'flaky' | 'real') =>
  [
    "const fs = require('fs');",
    "const files = process.argv.slice(2).filter((a) => a !== 'run');",
    "const changed = fs.existsSync('sim-output.md');",
    `const fails = changed && (files.length === 0 || ${mode === 'real' ? 'true' : 'false'});`,
    "if (fails) console.log(' FAIL  a.test.ts > A > renders the total');",
    "console.log(fails ? ' Tests  1 failed | 41 passed' : ' Tests  42 passed');",
    'process.exit(fails ? 1 : 0);',
  ].join('\n');

async function repoWith(app: TestApp, mode: 'flaky' | 'real'): Promise<string> {
  const repoPath = await makeRepo({ scripts: { test: 'vitest run' }, files: { 'fake-vitest.js': fakeVitest(mode), 'a.test.ts': '', 'b.test.ts': '' } });
  const bin = path.join(repoPath, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'vitest.cmd'), '@node "%~dp0\\..\\..\\fake-vitest.js" %*\r\n');
  writeFileSync(path.join(bin, 'vitest'), '#!/bin/sh\nexec node "$(dirname "$0")/../../fake-vitest.js" "$@"\n');
  await git(repoPath, ['add', '-f', 'node_modules']);
  await git(repoPath, ['update-index', '--chmod=+x', 'node_modules/.bin/vitest']);
  await git(repoPath, ['commit', '-m', 'fake runner']);
  return addRepo(app, repoPath);
}

describe('flaky tests', () => {
  it('a failure that passes when its files run again is flaky: reported, not blocking, and the checks still count as passed', async () => {
    t = await createTestApp();
    const repo = await repoWith(t, 'flaky');
    const id = await createTask(t, repo, 'Add a feature', { supervised: false, maxFixCycles: 0 });
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(task.status).toBe('COMPLETED');
    const runs = t.services.store.listTestRuns(id);
    const full = runs.find((r) => r.command === 'npm test')!;
    expect(full).toMatchObject({ status: 'failed', classification: 'flaky', failures: ['a.test.ts > A > renders the total'] });
    expect(full.summary).toContain('passed when run again on the same files: flaky, not blocking');
    const again = runs.find((r) => r.command === 'npm test -- a.test.ts')!;
    expect(again).toMatchObject({ status: 'passed', name: 'unit tests · failing files again' });
    expect(again.summary).toMatch(/^Re-run: passed/);
    expect(t.services.store.listStages(id).find((s) => s.stageKey === 'test')!.status).toBe('SUCCESS');
    // Reported, never hidden.
    expect(task.finalStatus).toBe('NEEDS_USER_ACTION');
    const report = t.services.store.listArtifacts(id).find((a) => a.name === 'final-report.md')!;
    expect((await t.services.artifacts.read(report, 100_000)).content).toContain('a flaky test, worth fixing separately');
    // The files the checks passed on are a tested tree: a release may send them.
    const { testedTrees } = await import('../src/release/service.js');
    expect(testedTrees(t.services.store, t.services.store.getTask(id)!, repo).size).toBe(1);
    expect(t.services.store.listEvents(id, { limit: 500 }).some((e) => e.type === 'FIX_CYCLE')).toBe(false);
  }, 120_000);

  it('a failure that fails again on its own is not flaky: it blocks as before', async () => {
    t = await createTestApp();
    const repo = await repoWith(t, 'real');
    const id = await createTask(t, repo, 'Add a feature', { supervised: false, maxFixCycles: 0 });
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(task.status).toBe('WAITING_FOR_USER');
    expect(task.blocker?.kind).toBe('fix_limit');
    const runs = t.services.store.listTestRuns(id);
    expect(runs.find((r) => r.command === 'npm test')).toMatchObject({ status: 'failed', classification: 'new' });
    expect(runs.find((r) => r.command === 'npm test -- a.test.ts')).toMatchObject({ status: 'failed' });
  }, 120_000);

  it('a repository where every failure blocks does not run the check again', async () => {
    t = await createTestApp();
    const repo = await repoWith(t, 'flaky');
    await t.api('PATCH', `/api/repositories/${repo}`, { preexistingFailures: 'block' });
    const id = await createTask(t, repo, 'Add a feature', { supervised: false, maxFixCycles: 0 });
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(task.status).toBe('WAITING_FOR_USER');
    expect(t.services.store.listTestRuns(id).some((r) => r.command === 'npm test -- a.test.ts')).toBe(false);
  }, 120_000);
});
