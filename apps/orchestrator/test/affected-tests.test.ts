import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaselineChecks } from '../src/engine/baseline-checks.js';
import { affectedTestsLine } from '../src/engine/report.js';
import { affectedOnly } from '../src/release/service.js';
import { guardRemoteCommand, type GuardContext } from '../src/remote/guards.js';
import { addRepo, createTask, createTestApp, IN_PLACE, makeRepo, waitForStatus, type TestApp } from './helpers.js';

/**
 * Affected tests only (docs/plans/AFFECTED_TESTS_PLAN.md §3.3–3.4), through the
 * real engine: a repository whose `npm test` runs a stand-in `vitest` that
 * records the arguments it was given and answers as the test chooses.
 */

let t: TestApp | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  await t?.close();
  t = null;
});

type StubMode = 'pass' | 'no-changed-option' | 'fail-with-ids';

/** A repository in the operator's folder (the stand-in lives in its ignored node_modules) and where the stand-in logs. */
async function stubRepo(mode: StubMode): Promise<{ repo: string; log: string }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-affected-'));
  const log = path.join(dir, 'vitest-args.log');
  const repo = await makeRepo({ scripts: { test: 'vitest run' }, files: { '.gitignore': 'node_modules\n' } });
  const bin = path.join(repo, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    path.join(bin, 'vitest-stub.cjs'),
    `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const narrowed = args.includes('--changed');
const mode = ${JSON.stringify(mode)};
if (mode === 'no-changed-option' && narrowed) { console.error('CACError: Unknown option \`--changed\`'); process.exit(1); }
if (mode === 'fail-with-ids' && narrowed) { console.log(' FAIL  src/price.test.ts > price > rounds'); console.log(' Tests  1 failed | 2 passed (3)'); process.exit(1); }
console.log(' Tests  ' + (narrowed ? 2 : 9) + ' passed (' + (narrowed ? 2 : 9) + ')');
`,
  );
  writeFileSync(path.join(bin, 'vitest'), '#!/bin/sh\nexec node "$(dirname "$0")/vitest-stub.cjs" "$@"\n');
  chmodSync(path.join(bin, 'vitest'), 0o755);
  writeFileSync(path.join(bin, 'vitest.cmd'), '@node "%~dp0vitest-stub.cjs" %*\r\n');
  return { repo, log };
}

const COMMANDS = [
  { id: 'lint', name: 'lint', command: 'node -e "console.log(\'lint ok\')"', kind: 'lint', enabled: true, timeoutSec: 120 },
  { id: 'test', name: 'test', command: 'npm test', kind: 'test', enabled: true, timeoutSec: 300 },
];

const calls = (log: string): string[][] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : []);

async function runTask(settings: Record<string, unknown>, mode: StubMode, description: string) {
  t = await createTestApp();
  const { repo, log } = await stubRepo(mode);
  const repoId = await addRepo(t, repo, { ...IN_PLACE, commands: COMMANDS, ...settings });
  const id = await createTask(t, repoId, description, { supervised: false });
  const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
  const runs = t.services.store.listTestRuns(id);
  return { id, task, runs, log, repoId, baseline: task.git.baselineCommit! };
}

async function finalReport(taskId: string): Promise<string> {
  const rec = t!.services.store.listArtifacts(taskId).filter((a) => a.name === 'final-report.md').at(-1)!;
  return (await t!.services.artifacts.read(rec, 2_000_000)).content;
}

describe('a tests stage on a repository that runs only affected tests', () => {
  it('narrows the Vitest test command to the change and says so; lint runs as before', async () => {
    const { task, runs, log, baseline, id } = await runTask({ testSelection: 'changed' }, 'pass', 'Change the price module [sim:source-only]');
    expect(task.status).toBe('COMPLETED');
    const test = runs.find((r) => r.kind === 'test')!;
    expect(test).toMatchObject({ status: 'passed', selection: 'changed', command: `npm test -- --changed ${baseline} --passWithNoTests` });
    expect(test.summary).toMatch(/^Affected by the change \(1 changed file\): .*2 passed/);
    expect(calls(log)[0]).toEqual(['run', '--changed', baseline, '--passWithNoTests']);
    expect(runs.find((r) => r.kind === 'lint')).toMatchObject({ status: 'passed', selection: null, command: COMMANDS[0]!.command });
    // A run of affected tests is never taken for a pass of the whole suite.
    expect(t!.services.store.findReusableRun(id, test.treeId!, 'npm test', null)).toBeNull();
    // The report says which tests ran, as information: the task is still READY (§3.5).
    expect(t!.services.store.getTask(id)!.finalStatus).toBe('READY');
    expect(await finalReport(id)).toContain(`- Unit tests (\`npm test\`): only the tests affected by the change ran (Vitest \`--changed ${baseline.slice(0, 7)}\`); the whole suite did not run.`);
    // …and so would a release approval of this commit.
    expect(affectedOnly(t!.services.store, t!.services.store.getTask(id)!, task.repositoryId)).toBe(true);
  }, 120_000);

  it('runs the whole suite and names the file when a change is not source the import graph covers', async () => {
    const { task, runs, log } = await runTask({ testSelection: 'changed' }, 'pass', 'Update the notes');
    expect(task.status).toBe('COMPLETED');
    const test = runs.find((r) => r.kind === 'test')!;
    expect(test).toMatchObject({ status: 'passed', selection: 'full', command: 'npm test' });
    expect(test.summary).toMatch(/^Whole suite — sim-output\.md is not source code; tests may read it: .*9 passed/);
    expect(calls(log)[0]).toEqual(['run']);
  }, 120_000);

  it('runs the whole suite once instead when the narrowed run cannot run any test, and the task is not held back by it', async () => {
    const { id, task, runs, log } = await runTask({ testSelection: 'changed' }, 'no-changed-option', 'Change the price module [sim:source-only]');
    expect(task.status).toBe('COMPLETED');
    const tests = runs.filter((r) => r.kind === 'test');
    expect(tests).toHaveLength(2);
    expect(tests[0]).toMatchObject({ status: 'not_run', selection: 'changed' });
    expect(tests[0]!.summary).toMatch(/^Superseded: could not run only the affected tests \(.*Unknown option.*\); the whole suite ran instead$/);
    expect(tests[1]).toMatchObject({ name: 'test · whole suite', status: 'passed', selection: 'full', command: 'npm test' });
    expect(tests[1]!.summary).toMatch(/^Whole suite \(the affected tests could not run\): .*9 passed/);
    expect(calls(log).map((a) => a.includes('--changed'))).toEqual([true, false]);
    // The superseded row is neither a pass nor a failure: the report is READY.
    expect(t!.services.store.getTask(id)!.finalStatus).toBe('READY');
  }, 120_000);

  it('compares a failure of the narrowed run with the baseline using the original command', async () => {
    const classify = vi.spyOn(BaselineChecks.prototype, 'classify').mockImplementation(async (input) => ({ classification: 'preexisting', baselineCommit: input.baselineCommit, reason: null }));
    const { task, runs } = await runTask({ testSelection: 'changed' }, 'fail-with-ids', 'Change the price module [sim:source-only]');
    expect(task.status).toBe('COMPLETED');
    expect(classify).toHaveBeenCalled();
    expect(classify.mock.calls[0]![0].command.command).toBe('npm test');
    expect(classify.mock.calls[0]![0].failures).toEqual(['src/price.test.ts > price > rounds']);
    expect(runs.find((r) => r.kind === 'test')).toMatchObject({ status: 'failed', classification: 'preexisting', selection: 'changed' });
  }, 120_000);
});

describe('a repository that did not opt in', () => {
  it('runs exactly the commands it always ran, with nothing new recorded', async () => {
    const { task, runs, log } = await runTask({}, 'pass', 'Change the price module [sim:source-only]');
    expect(task.status).toBe('COMPLETED');
    expect(runs.map((r) => [r.kind, r.command, r.selection])).toEqual([
      ['lint', COMMANDS[0]!.command, null],
      ['test', 'npm test', null],
    ]);
    expect(runs.find((r) => r.kind === 'test')!.summary).not.toMatch(/Affected|Whole suite/);
    expect(calls(log)).toEqual([['run']]);
    expect(await finalReport(task.id)).not.toContain('only the tests affected by the change');
    expect(affectedOnly(t!.services.store, task, task.repositoryId)).toBe(false);
  }, 120_000);
});

describe('what is said, and who may turn it on', () => {
  it('names the command the operator configured, not the narrowed line', () => {
    const sha = 'd'.repeat(40);
    expect(affectedTestsLine({ command: `npm test -- --changed ${sha} --passWithNoTests` })).toBe('- Unit tests (`npm test`): only the tests affected by the change ran (Vitest `--changed ddddddd`); the whole suite did not run.');
    expect(affectedTestsLine({ command: `npx vitest run --changed ${sha} --passWithNoTests` })).toContain('(`npx vitest run`)');
  });

  it('lets only this machine turn affected tests on; the cloud may turn them off', () => {
    const ctx = (testSelection: 'full' | 'changed'): GuardContext => ({ settings: { autoApproveUpToLevel: 3, execution: { policyMode: 'safe' } } as never, repository: () => ({ runtime: {} as never, autoApproveUpToLevel: null, policyMode: null, testSelection }), workflow: () => null });
    const on = guardRemoteCommand('repository.update', { id: 'r1' }, { testSelection: 'changed' }, ctx('full'));
    expect(on).toEqual({ ok: false, message: 'Running only affected tests can only be turned on on this machine.' });
    expect(guardRemoteCommand('repository.update', { id: 'r1' }, { testSelection: 'full' }, ctx('changed')).ok).toBe(true);
    expect(guardRemoteCommand('repository.update', { id: 'r1' }, { testSelection: 'changed' }, ctx('changed')).ok).toBe(true);
    expect(guardRemoteCommand('repository.update', { id: 'r1' }, { name: 'renamed' }, ctx('full')).ok).toBe(true);
  });
});
