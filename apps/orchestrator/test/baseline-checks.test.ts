import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addRepo, createTask, createTestApp, makeRepo, type TestApp } from './helpers.js';

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
