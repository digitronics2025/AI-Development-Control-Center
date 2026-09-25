import { afterEach, describe, expect, it } from 'vitest';
import { unreviewedFiles } from '../src/engine/runners.js';
import { addRepo, createTask, createTestApp, makeRepo, TOKEN, waitFor, waitForStatus, type TestApp } from './helpers.js';

/** Gates that tell the truth (docs/plans/AUTOPILOT_GATES_PLAN.md). */

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function artifactText(app: TestApp, taskId: string, name: string, which: 'first' | 'last' = 'last'): Promise<string> {
  const recs = app.services.store.listArtifacts(taskId).filter((a) => a.name === name);
  const rec = which === 'first' ? recs[0] : recs.at(-1);
  if (!rec) throw new Error(`no artifact ${name}`);
  return (await app.services.artifacts.read(rec, 2_000_000)).content;
}

describe('A. complete review coverage', () => {
  it('names every file the diff does not show, and a diligent review that names them passes', async () => {
    t = await createTestApp();
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'Big change [sim:big-diff]');
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(t.services.store.getTask(id)!.status).toBe('COMPLETED');

    const prompt = await artifactText(t, id, 'review-prompt.md');
    expect(prompt).toContain('Diff shows 2 of 4 changed files in full.');
    expect(prompt).toMatch(/^- big-b\.ts \(\+1500 −0, too large for the budget\) → read: /m);
    expect(prompt).toMatch(/^- big-c\.ts \(\+1500 −0, too large for the budget\) → read: /m);
    // The trailer is written after packing, so it survives; the changed-files list carries line counts.
    expect(prompt).toContain('2 changed files are not shown in full here; see Diff coverage');
    expect(prompt).toMatch(/^- big-a\.ts \(untracked, \+1500 −0, task change\)$/m);
    expect((await artifactText(t, id, 'review.md')).includes('## Files reviewed')).toBe(true);
    // One execution per review stage: nothing had to be asked twice.
    const review = t.services.store.listStages(id).find((s) => s.stageKey === 'review')!;
    expect(t.services.store.listExecutions(id).filter((e) => e.stageId === review.id)).toHaveLength(1);
  }, 90_000);

  it('asks a PASS that skipped a file once more inside the same stage', async () => {
    t = await createTestApp();
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'Big change [sim:big-diff] [sim:review-miss-coverage-once]');
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(t.services.store.getTask(id)!.status).toBe('COMPLETED');
    const review = t.services.store.listStages(id).filter((s) => s.stageKey === 'review');
    expect(review).toHaveLength(1);
    expect(review[0]!.attempt).toBe(1);
    expect(t.services.store.listExecutions(id).filter((e) => e.stageId === review[0]!.id)).toHaveLength(2);
    const retry = t.services.store.listEvents(id, { limit: 500 }).find((e) => e.type === 'STAGE_RETRY' && e.message.includes('without accounting for 2 changed files'));
    expect(retry?.message).toContain('big-b.ts, big-c.ts');
  }, 90_000);

  it('fails the stage as REVIEW_INCOMPLETE when the second PASS still skips a file', async () => {
    t = await createTestApp();
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'Big change [sim:big-diff] [sim:review-miss-coverage]', { supervised: false });
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(task.status).toBe('FAILED');
    expect(task.blocker).toMatchObject({ errorClass: 'REVIEW_INCOMPLETE', stageKey: 'review' });
    expect(task.blocker!.message).toContain('big-b.ts, big-c.ts');
    const reviews = t.services.store.listStages(id).filter((s) => s.stageKey === 'review');
    expect(reviews.every((s) => s.errorClass === 'REVIEW_INCOMPLETE' && s.status === 'FAILED')).toBe(true);
  }, 90_000);

  it('never second-guesses a FAIL: it goes to the fix route without a coverage follow-up', async () => {
    t = await createTestApp();
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'Big change [sim:big-diff] [sim:review-fail-once] [sim:review-miss-coverage-once]');
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    const first = t.services.store.listStages(id).find((s) => s.stageKey === 'review')!;
    expect(first.verdict).toBe('FAIL');
    expect(t.services.store.listExecutions(id).filter((e) => e.stageId === first.id)).toHaveLength(1);
  }, 90_000);

  it('packs the diffs of a task across repositories into one budget and names what it leaves out', async () => {
    t = await createTestApp();
    const api = await addRepo(t, await makeRepo());
    const web = await addRepo(t, await makeRepo());
    const id = await createTask(t, api, 'Across repositories [sim:big-diff]', { linkedRepositoryIds: [web] });
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    const prompt = await artifactText(t, id, 'review-prompt.md');
    const folder = t.services.store.getTask(id)!.git.folder!;
    expect(prompt).toMatch(/Diff shows \d+ of 5 changed files in full\./);
    // Which two of the three equal files miss the budget depends on the workspace's folder order; that two do is what matters.
    const notShown = [...prompt.matchAll(/^- (\S+) \(\+1500 −0, too large for the budget\) → read: the file itself \(new, untracked\)$/gm)].map((m) => m[1]);
    expect(notShown).toHaveLength(2);
    for (const file of notShown) expect(file).toMatch(new RegExp(`^${folder}/big-[abc]\\.ts$`));
    expect(prompt).toContain('3 of 5 changed files in full');
  }, 120_000);

  it('packs a staged diff and asks for every file it leaves out', async () => {
    t = await createTestApp();
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'Review what is staged', { start: false });
    const big = (name: string) => `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n@@ -1,1 +1,2000 @@\n${Array.from({ length: 2000 }, (_, i) => `+line ${i} ${'z'.repeat(40)}`).join('\n')}\n`;
    await t.services.artifacts.write(id, { name: 'staged.diff', type: 'staged-diff', content: big('src/one.ts') + big('src/two.ts') });
    const task = t.services.store.getTask(id)!;
    const def = task.workflow.stages.find((s) => s.key === 'review')!;
    const built = await t.services.context.build(task, def, { id: 'x', createdAt: new Date().toISOString() } as never);
    expect(built.coverage.required).toEqual(['src/two.ts']);
    expect(built.prompt).toContain('- src/two.ts (binary, too large for the budget) → read: git diff --cached -- src/two.ts');
  });
});

describe('A. coverage matching', () => {
  it('accepts a full path, or a basename only when no other changed file shares it', () => {
    const coverage = { required: ['src/a/index.ts', 'src/unique.ts'], all: ['src/a/index.ts', 'src/b/index.ts', 'src/unique.ts'] };
    expect(unreviewedFiles('Read unique.ts and index.ts', coverage)).toEqual(['src/a/index.ts']);
    expect(unreviewedFiles('- src\\a\\index.ts ok\n- src/unique.ts ok', coverage)).toEqual([]);
  });
});

describe('D. stage prerequisites and optional-stage failures', () => {
  it('refuses a workflow whose stage requires a stage that does not exist', async () => {
    const { validateWorkflow } = await import('@acc/shared');
    const { issues } = validateWorkflow({ id: 'x', name: 'X', stages: [{ key: 'a', name: 'A', role: 'implementer', next: 'b' }, { key: 'b', name: 'B', role: 'tester', kind: 'command', commandKinds: ['smoke'], requires: ['nope'], next: 'complete' }] });
    expect(issues).toEqual([expect.objectContaining({ field: 'requires', message: '"nope" is not a stage in this workflow' })]);
  });

  it('skips Smoke when Staging did not run, without asking, failing or recovering', async () => {
    t = await createTestApp();
    const repo = await addRepo(t, await makeRepo({ scripts: { test: 'node -e "0"', smoke: 'node -e "process.exit(1)"' } }));
    const id = await createTask(t, repo, 'Document it', { workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.recoveryCycle).toBe(0);
    const smoke = t.services.store.latestStage(id, 'smoke')!;
    expect(smoke).toMatchObject({ status: 'SKIPPED', summary: 'Skipped: Staging deploy did not run' });
    // Nothing ran for it.
    expect(t.services.store.listTestRuns(id).some((r) => r.kind === 'smoke')).toBe(false);
  }, 90_000);

  it('turns a failed optional stage into a report limitation and moves on without the Chairman', async () => {
    t = await createTestApp();
    const repoPath = await makeRepo({ scripts: { test: 'node -e "0"', smoke: 'node -e "0"' } });
    const repo = await addRepo(t, repoPath);
    const rec = (await t.api('GET', `/api/repositories/${repo}`)).body;
    await t.api('PATCH', `/api/repositories/${repo}`, {
      commands: [...rec.commands, { id: 'staging', name: 'staging deploy', command: 'node -e "console.error(\'deploy refused\'); process.exit(3)"', kind: 'deploy-staging', enabled: true, timeoutSec: 60 }],
    });
    const id = await createTask(t, repo, 'Ship it', { workflowId: 'full-autopilot' });
    await waitForStatus(t, id, ['WAITING_FOR_USER'], 60_000);
    const [approval] = (await t.api('GET', '/api/approvals')).body;
    await t.api('POST', `/api/approvals/${approval.id}/approve`, {});
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED'], 60_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.finalStatus).toBe('NEEDS_USER_ACTION');
    expect(done.recoveryCycle).toBe(0);
    expect(t.services.store.latestStage(id, 'staging')!.status).toBe('FAILED');
    expect(t.services.store.latestStage(id, 'smoke')).toMatchObject({ status: 'SKIPPED', summary: 'Skipped: Staging deploy did not succeed' });
    const events = t.services.store.listEvents(id, { limit: 1000 });
    expect(events.some((e) => e.type === 'STAGE_OPTIONAL_FAILED')).toBe(true);
    expect(events.some((e) => e.type === 'CHAIRMAN_DECISION' || e.type === 'RECOVERY_CYCLE')).toBe(false);
    expect(await artifactText(t, id, 'final-report.md')).toContain('Staging deploy (optional) failed: staging deploy failed');
  }, 90_000);
});

/** A committed check script: prints each failing test the way Vitest does, exits 1 when any failed. */
function checkScript(always: string[], whenChanged: string[]): string {
  return [
    "const fs = require('fs');",
    `const failed = ${JSON.stringify(always)};`,
    `if (fs.existsSync('sim-output.md')) failed.push(...${JSON.stringify(whenChanged)});`,
    "for (const f of failed) console.log(' FAIL  ' + f);",
    "console.log(failed.length ? ' Tests  ' + failed.length + ' failed | 3 passed' : ' Tests  3 passed');",
    'process.exit(failed.length ? 1 : 0);',
  ].join('\n');
}

async function saveWorkflow(app: TestApp, id: string, stages: unknown[]): Promise<void> {
  const res = await app.api('PUT', `/api/workflows/${id}`, { id, name: id, stages, maxFixCycles: 1 });
  if (res.status >= 300) throw new Error(JSON.stringify(res.body));
}

describe('B. baseline-aware checks', () => {
  it('reads failing test ids from Playwright, Vitest, Jest and pytest output, and stops at 500', async () => {
    const { failureIdsIn, FailureIdCollector, normalizeTestId } = await import('../src/engine/test-summary.js');
    // The Playwright summary block as TASK-0007's e2e suite printed it (colours included).
    const playwright = [
      '  1) [chromium] › e2e/partners.spec.ts:41:7 › Partners › lists partners ─────────────',
      '',
      '  10 failed',
      '    \u001b[31m[chromium] › e2e/banks.spec.ts:12:5 › Banks › creates a bank account\u001b[39m',
      '    [chromium] › e2e/partners.spec.ts:41:7 › Partners › lists partners',
      // Seen in TASK-0007's real output: a title padded with a box-drawing rule.
      '    [chromium] › tests\\e2e\\auth.spec.ts:30:3 › Authentication flows › logout returns to login page ─',
      '  2 flaky',
      '    [chromium] › e2e/flaky.spec.ts:3:1 › sometimes',
      '  48 passed (3.1m)',
    ].join('\n');
    expect(failureIdsIn(playwright)).toEqual([
      '[chromium] › e2e/banks.spec.ts › Banks › creates a bank account',
      '[chromium] › e2e/partners.spec.ts › Partners › lists partners',
      '[chromium] › tests\\e2e\\auth.spec.ts › Authentication flows › logout returns to login page',
    ]);
    expect(failureIdsIn(' FAIL  src/partners.test.ts > Partners > rounds 2 halves 12ms\n × src/x.test.ts > case 1 (4 ms)')).toEqual(['src/partners.test.ts > Partners > rounds 2 halves', 'src/x.test.ts > case 1']);
    expect(failureIdsIn('  ✕ adds numbers (5 ms)\nFAIL src/sum.test.js')).toEqual(['adds numbers', 'src/sum.test.js']);
    expect(failureIdsIn('FAILED tests/test_api.py::test_login - AssertionError: 401 != 200')).toEqual(['tests/test_api.py::test_login']);
    // Digits in a name are kept: "case 1" and "case 2" are different tests.
    expect(normalizeTestId('case 1')).not.toBe(normalizeTestId('case 2'));
    const collector = new FailureIdCollector();
    for (let i = 0; i < 600; i++) collector.push(`FAIL test ${i}`);
    expect(collector.list()).toHaveLength(500);
    expect(collector.overflow).toBe(true);
  });

  it('classifies a failure against the baseline, failing closed', async () => {
    const { classifyFailures } = await import('../src/engine/baseline-checks.js');
    const task = (failures: string[], overflow = false) => ({ failures, overflow });
    expect(classifyFailures(task(['a', 'b']), { status: 'failed', failures: ['a', 'b', 'c'] })).toBe('preexisting');
    expect(classifyFailures(task(['a', 'd']), { status: 'failed', failures: ['a', 'b'] })).toBe('new');
    expect(classifyFailures(task(['a']), { status: 'passed', failures: [] })).toBe('new');
    expect(classifyFailures(task([]), { status: 'failed', failures: ['a'] })).toBe('unknown');
    expect(classifyFailures(task(['a']), { status: 'failed', failures: [] })).toBe('unknown');
    expect(classifyFailures(task(['a'], true), { status: 'failed', failures: ['a'] })).toBe('unknown');
    expect(classifyFailures(task(['a']), { status: 'error', failures: [] })).toBe('unknown');
    expect(classifyFailures(task(['a']), null)).toBe('unknown');
  });

  it('does not block on failures the baseline already had: the stage goes on and the report says so', async () => {
    t = await createTestApp();
    const repoPath = await makeRepo({ files: { 'check.js': checkScript(['src/partners.test.ts > Partners > rounds'], []) }, scripts: { test: 'node check.js', lint: 'node -e "0"' } });
    const repo = await addRepo(t, repoPath);
    const id = await createTask(t, repo, 'Document it');
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.fixCycles).toBe(0);
    const runs = t.services.store.listTestRuns(id);
    const test = runs.find((r) => r.kind === 'test')!;
    expect(test).toMatchObject({ status: 'failed', classification: 'preexisting', failures: ['src/partners.test.ts > Partners > rounds'] });
    expect(runs.find((r) => r.kind === 'lint')!.status).toBe('passed');
    expect(t.services.store.latestStage(id, 'test')).toMatchObject({ status: 'SUCCESS' });
    expect(done.finalStatus).toBe('NEEDS_USER_ACTION');
    expect(await artifactText(t, id, 'final-report.md')).toMatch(/1 pre-existing failure in `[^`]+` was left as it was/);
    expect(await artifactText(t, id, 'tests.log')).toMatch(/all 1 failing as before on [0-9a-f]{7}/);
    // The review saw them apart from the task's own results.
    expect(await artifactText(t, id, 'review-prompt.md')).toContain('### Already failing before this task — do not fix unless asked');
    // The baseline ran once, in a detached worktree that is gone again.
    expect(t.services.store.listExecutions(id).filter((e) => e.command.startsWith('baseline '))).toHaveLength(1);
    const { readdirSync, existsSync } = await import('node:fs');
    const root = `${t.dataDir}/baselines`;
    expect(existsSync(root) ? readdirSync(root).flatMap((d) => readdirSync(`${root}/${d}`)) : []).toEqual([]);
  }, 90_000);

  it('blocks on a failure that is new since the baseline, as before', async () => {
    t = await createTestApp();
    const repoPath = await makeRepo({ files: { 'check.js': checkScript(['src/old.test.ts > old'], ['src/new.test.ts > broke']) }, scripts: { test: 'node check.js' } });
    const id = await createTask(t, await addRepo(t, repoPath), 'Break something', { supervised: false });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.status).toBe('WAITING_FOR_USER');
    expect(done.blocker?.kind).toBe('fix_limit');
    const first = t.services.store.listTestRuns(id).find((r) => r.kind === 'test')!;
    expect(first.classification).toBe('new');
    expect(t.services.store.listEvents(id, { limit: 500 }).some((e) => e.type === 'TEST_FAILED' && e.message.includes('new since the baseline'))).toBe(true);
    // One baseline run served every later failure of the same command on the same commit.
    expect(t.services.store.listExecutions(id).filter((e) => e.command.startsWith('baseline '))).toHaveLength(1);
  }, 90_000);

  it("keeps today's strict behaviour when the repository says every failure blocks", async () => {
    t = await createTestApp();
    const repoPath = await makeRepo({ files: { 'check.js': checkScript(['src/old.test.ts > old'], []) }, scripts: { test: 'node check.js' } });
    const repo = await addRepo(t, repoPath);
    expect((await t.api('PATCH', `/api/repositories/${repo}`, { preexistingFailures: 'block' })).body.preexistingFailures).toBe('block');
    const id = await createTask(t, repo, 'Strict', { supervised: false });
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    const run = t.services.store.listTestRuns(id).find((r) => r.kind === 'test')!;
    expect(run).toMatchObject({ status: 'failed', classification: null });
    expect(t.services.store.listExecutions(id).some((e) => e.command.startsWith('baseline '))).toBe(false);
  }, 90_000);

  it('shares one baseline run per key, never runs two at once, and removes its worktree even on a timeout', async () => {
    const { BaselineChecks } = await import('../src/engine/baseline-checks.js');
    const gitLib = await import('@acc/git');
    t = await createTestApp();
    const repoPath = await makeRepo({ files: { 'check.js': checkScript(['a > b'], []) } });
    const repo = await addRepo(t, repoPath);
    const id = await createTask(t, repo, 'Probe', { start: false });
    const { store, bus, tooling } = t.services;
    const checks = new BaselineChecks({ store, bus, tooling, dataDir: t.dataDir });
    const task = store.getTask(id)!;
    const head = (await gitLib.headCommit(repoPath))!;
    const stage = { id: 'stage-x', createdAt: new Date().toISOString() } as never;
    const command = { id: 'test', name: 'unit tests', command: 'node check.js', kind: 'test' as const, enabled: true, timeoutSec: 60 };
    const input = { task, stage, repo: store.getRepository(repo)!, baselineCommit: head, command, env: process.env, failures: ['a > b'], overflow: false };
    const stopped = { stopped: () => false };
    const baselineRuns = () => store.listExecutions(id).filter((e) => e.command.startsWith('baseline ')).length;
    const [one, two] = await Promise.all([checks.classify(input, stopped), checks.classify(input, stopped)]);
    expect([one.classification, two.classification]).toEqual(['preexisting', 'preexisting']);
    expect(baselineRuns()).toBe(1);
    // Cached: a third question runs nothing.
    expect((await checks.classify(input, stopped)).classification).toBe('preexisting');
    expect(baselineRuns()).toBe(1);
    // A command that hangs: unknown, with the reason, and nothing left behind.
    const slow = { ...command, id: 'slow', command: 'node -e "setTimeout(() => {}, 60000)"', timeoutSec: 5 };
    const timedOut = await checks.classify({ ...input, command: slow }, stopped);
    expect(timedOut).toMatchObject({ classification: 'unknown', reason: expect.stringContaining('timed out') });
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(checks.root()).flatMap((d) => readdirSync(`${checks.root()}/${d}`))).toEqual([]);
    const worktrees = (await gitLib.git(repoPath, ['worktree', 'list'])).stdout.trim().split('\n');
    expect(worktrees).toHaveLength(1);
  }, 90_000);
});

describe('C. per-task check waiver', () => {
  it('stops gating one task on a waived kind, and only that task', async () => {
    t = await createTestApp();
    const repoPath = await makeRepo({ scripts: { test: 'node -e "0"', 'test:e2e': 'node -e "console.log(\'FAIL e2e/a.spec.ts > a\'); process.exit(1)"' } });
    const repo = await addRepo(t, repoPath);
    const waivedTask = await createTask(t, repo, 'Waived [sim:slow]', { workflowId: 'full-autopilot' });
    await waitForStatus(t, waivedTask, ['RUNNING'], 20_000);
    const res = await t.api('POST', `/api/tasks/${waivedTask}/directives`, { text: "Don't gate this task on e2e: the suite is out of date.", rule: { type: 'waive_check', kinds: ['e2e'] } });
    expect(res.status).toBeLessThan(300);
    expect(res.body.rule).toEqual({ type: 'waive_check', kinds: ['e2e'] });
    const done = await waitForStatus(t, waivedTask, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(done.status).toBe('COMPLETED');
    expect(t.services.store.listTestRuns(waivedTask).some((r) => r.kind === 'e2e')).toBe(false);
    expect(await artifactText(t, waivedTask, 'final-report.md')).toContain('Not gated on e2e for this task, by your directive: "Don\'t gate this task on e2e');

    const other = await createTask(t, repo, 'Not waived', { workflowId: 'full-autopilot', supervised: false });
    await waitForStatus(t, other, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(t.services.store.listTestRuns(other).some((r) => r.kind === 'e2e')).toBe(true);
  }, 180_000);

  it('refuses a waiver from the Chairman, chat or anything but the operator route', async () => {
    t = await createTestApp();
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'Guarded', { start: false });
    const action = await t.services.chairman.gateway.execute(id, { type: 'ADD_DIRECTIVE', params: { text: 'skip e2e', rule: { type: 'waive_check', kinds: ['e2e'] } } } as never, { initiator: 'chairman', source: 'supervisor' });
    expect(action.status).not.toBe('completed');
    expect(t.services.store.listDirectives(id).some((d) => d.rule?.type === 'waive_check')).toBe(false);
    // The operator route accepts the waiver and nothing else as a rule.
    const bad = await t.api('POST', `/api/tasks/${id}/directives`, { text: 'x', rule: { type: 'routing', stageKey: 'plan', agentId: 'codex' } });
    expect(bad.status).toBe(400);
  });

  it('lets the waiver win over a directive that requires the same check', async () => {
    const { completionGate } = await import('../src/chairman/gate.js');
    const workflow = { id: 'w', name: 'w', description: '', version: 1, maxFixCycles: 1, builtin: false, stages: [{ key: 'test', name: 'Test', role: 'tester', kind: 'tests', permissionLevel: 2, timeoutSec: 60, retry: { maxAttempts: 1 }, requiresApproval: false, next: 'complete', verdict: false, optional: false }] } as never;
    const stages = [{ id: 's1', stageKey: 'test', kind: 'tests', role: 'tester', status: 'SUCCESS', createdAt: '2026-01-01T00:00:00Z', verdict: null }] as never;
    const required = [{ state: 'active', rule: { type: 'require_check', kinds: ['e2e'] }, text: 'run e2e' }] as never;
    const base = { workflow, stages, testRuns: [] as never[], activeDirectives: required, taskFiles: [], configuredKinds: new Set(['test', 'e2e'] as const) };
    expect(completionGate(base).pass).toBe(false);
    expect(completionGate({ ...base, waivedKinds: new Set(['e2e'] as const) }).pass).toBe(true);
    // A required check already failing on the baseline is not a pass, and no rerun can make it one.
    const pre = completionGate({ ...base, testRuns: [{ stageId: 's1', kind: 'e2e', status: 'failed', classification: 'preexisting' }] as never });
    expect(pre.failures).toEqual([expect.objectContaining({ code: 'required_check', remedy: null, message: expect.stringContaining('already failing before this task') })]);
  });
});

describe('E. check-result reuse', () => {
  it("reuses a pass on identical files, runs again after a change, and never reuses a failure or another task's run", async () => {
    t = await createTestApp();
    const repoPath = await makeRepo({ scripts: { test: 'node -e "console.log(\'3 passed\')"' } });
    const repo = await addRepo(t, repoPath);
    await saveWorkflow(t, 'twice', [
      { key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, next: 'test' },
      { key: 'test', name: 'Test', role: 'tester', kind: 'tests', permissionLevel: 2, next: 'again' },
      { key: 'again', name: 'Test again', role: 'tester', kind: 'tests', permissionLevel: 2, next: 'change' },
      { key: 'change', name: 'Change', role: 'implementer', permissionLevel: 2, next: 'final' },
      { key: 'final', name: 'Final test', role: 'tester', kind: 'tests', permissionLevel: 2, next: 'complete' },
    ]);
    const id = await createTask(t, repo, 'Twice', { workflowId: 'twice' });
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    const byStage = (key: string) => t!.services.store.listTestRuns(id, t!.services.store.latestStage(id, key)!.id)[0]!;
    const first = byStage('test');
    expect(first).toMatchObject({ status: 'passed', reusedFrom: null });
    expect(first.treeId).toMatch(/^[0-9a-f]{40}$/);
    expect(byStage('again')).toMatchObject({ status: 'passed', reusedFrom: first.id, durationMs: 0, summary: expect.stringContaining('Reused: same files as Test at') });
    expect(byStage('final')).toMatchObject({ status: 'passed', reusedFrom: null });
    expect(byStage('final').treeId).not.toBe(first.treeId);

    // The lookup itself: failures and other tasks never count.
    const { store } = t.services;
    expect(store.findReusableRun(id, first.treeId!, first.command, null)?.status).toBe('passed');
    expect(store.findReusableRun('TASK-9999', first.treeId!, first.command, null)).toBeNull();
    store.insertTestRun({ ...first, id: 'failed-run', status: 'failed', treeId: 'f'.repeat(40), reusedFrom: null });
    expect(store.findReusableRun(id, 'f'.repeat(40), first.command, null)).toBeNull();
  }, 90_000);

  it('rejects retrying a required check on unchanged files, and says why', async () => {
    t = await createTestApp();
    const repoPath = await makeRepo({ scripts: { test: 'node -e "0"', smoke: 'node -e "console.log(\'smoke: 500\'); process.exit(1)"' } });
    const repo = await addRepo(t, repoPath);
    await saveWorkflow(t, 'smoke-required', [
      { key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, next: 'smoke' },
      { key: 'smoke', name: 'Smoke test', role: 'tester', kind: 'command', commandKinds: ['smoke'], permissionLevel: 2, next: 'complete' },
    ]);
    const id = await createTask(t, repo, 'Smoke it', { workflowId: 'smoke-required' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.status).toBe('WAITING_FOR_USER');
    expect(done.blocker?.kind).toBe('hard_blocker');
    expect(done.blocker?.message).toContain('the check command failed');
    expect(done.blocker?.message).toContain('Running it again would change nothing');
    expect(done.recoveryCycle).toBe(0);
    expect(t.services.store.listStages(id).filter((s) => s.stageKey === 'smoke')).toHaveLength(1);
  }, 90_000);
});

describe('D. the TASK-0007 sequence, replayed with simulated agents', () => {
  it('finishes with pre-existing failures reported, Smoke skipped and no recovery cycle', async () => {
    t = await createTestApp();
    const repoPath = await makeRepo({
      files: {
        'check.js': checkScript(['src/partners.test.ts > Partners > rounds'], []),
        'e2e.js': checkScript(Array.from({ length: 10 }, (_, i) => `e2e/suite.spec.ts > old flow ${i + 1}`), []),
      },
      scripts: { test: 'node check.js', 'test:e2e': 'node e2e.js', smoke: 'node -e "process.exit(1)"' },
    });
    const id = await createTask(t, await addRepo(t, repoPath), 'Read the attachment [sim:big-diff]', { workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 120_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.recoveryCycle).toBe(0);
    expect(done.fixCycles).toBe(0);
    const failed = t.services.store.listTestRuns(id).filter((r) => r.status === 'failed');
    expect(failed.map((r) => [r.kind, r.classification, r.failures?.length])).toEqual([
      ['test', 'preexisting', 1],
      ['e2e', 'preexisting', 10],
    ]);
    expect(t.services.store.latestStage(id, 'smoke')).toMatchObject({ status: 'SKIPPED', summary: 'Skipped: Staging deploy did not run' });
    expect(await artifactText(t, id, 'final-report.md')).toMatch(/10 pre-existing failures in `[^`]+` were left as they were/);
    // The worktree is gone and the operator's checkout never changed branch.
    expect(done.git.isolated).toBe(true);
    expect(done.git.worktreePath).toBeNull();
    expect(await (await import('@acc/git')).currentBranch(repoPath)).toBe('main');
  }, 180_000);
});

describe('F. isolation by default', () => {
  it('gives a new repository isolated worktrees', async () => {
    t = await createTestApp();
    const repo = await addRepo(t, await makeRepo());
    expect((await t.api('GET', `/api/repositories/${repo}`)).body).toMatchObject({ gitMode: 'worktree', preexistingFailures: 'allow' });
  });

  it('stops before touching your folder when the worktree cannot be created, and resumes once it can', async () => {
    const gitLib = await import('@acc/git');
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const path = await import('node:path');
    t = await createTestApp();
    const repoPath = await makeRepo({ dirty: { 'notes.txt': 'my own work\n' } });
    const repo = await addRepo(t, repoPath);
    // A file where the worktree folder must go makes `git worktree add` fail.
    const root = t.services.tooling.worktreeRoot(t.services.store.getRepository(repo)!);
    mkdirSync(path.dirname(root), { recursive: true });
    writeFileSync(root, 'in the way');
    const before = { branch: await gitLib.currentBranch(repoPath), status: await gitLib.status(repoPath) };
    const id = await createTask(t, repo, 'Isolated or nothing');
    const blocked = await waitForStatus(t, id, ['WAITING_FOR_USER', 'COMPLETED', 'FAILED'], 30_000);
    expect(blocked.blocker).toMatchObject({ kind: 'hard_blocker', message: expect.stringContaining("Couldn't create an isolated worktree") });
    expect(blocked.blocker!.message).toContain('Your working folder was not touched');
    expect({ branch: await gitLib.currentBranch(repoPath), status: await gitLib.status(repoPath) }).toEqual(before);
    expect(blocked.git.isolated).toBe(true);

    rmSync(root, { force: true });
    expect((await t.api('POST', `/api/tasks/${id}/resume`)).status).toBe(200);
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.git.worktreePath).toBeNull();
    expect({ branch: await gitLib.currentBranch(repoPath), status: await gitLib.status(repoPath) }).toEqual(before);
  }, 90_000);
});

describe('G. restart guard', () => {
  async function serverWithShutdown(app: TestApp) {
    const { buildServer } = await import('../src/http/server.js');
    const calls: string[] = [];
    const server = await buildServer(app.services, { onShutdownRequest: () => calls.push('shutdown') });
    const post = async (body: unknown) => {
      const res = await server.inject({ method: 'POST', url: '/api/service/shutdown', headers: { host: '127.0.0.1:4317', authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
      return { status: res.statusCode, body: JSON.parse(res.body) };
    };
    return { calls, post, close: () => server.close() };
  }

  it('refuses while a stage runs, forces when told, and shuts down at once when idle', async () => {
    t = await createTestApp();
    const s = await serverWithShutdown(t);
    const idle = await s.post({});
    expect(idle.status).toBe(202);
    await waitFor(() => s.calls.length, (n) => n === 1, 5_000, 'idle shutdown');

    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Long [sim:slow]');
    await waitFor(() => t!.services.engine.runningStages(), (r) => r.some((x) => x.taskId === id && x.stage !== null), 20_000, 'a running stage');
    const refused = await s.post({});
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('TASKS_RUNNING');
    expect(refused.body.running).toEqual([{ taskId: id, stage: expect.any(String) }]);
    expect(s.calls).toHaveLength(1);
    const forced = await s.post({ mode: 'force' });
    expect(forced.status).toBe(202);
    await waitFor(() => s.calls.length, (n) => n === 2, 5_000, 'forced shutdown');
    await s.close();
  }, 60_000);

  it('drains: the running stage finishes, the task stops at the boundary, and it resumes by itself after the restart', async () => {
    t = await createTestApp();
    const dataDir = t.dataDir;
    const s = await serverWithShutdown(t);
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Restart me [sim:slow]');
    await waitFor(() => t!.services.store.getTask(id)!.currentStageKey, (k) => k === 'plan', 30_000, 'the plan stage');
    const draining = await s.post({ mode: 'drain' });
    expect(draining.status).toBe(202);
    expect(draining.body).toMatchObject({ draining: true, waitingFor: [{ taskId: id }] });
    await waitFor(() => s.calls.length, (n) => n === 1, 30_000, 'the drained shutdown');
    const stopped = t.services.store.getTask(id)!;
    expect(stopped.status).toBe('INTERRUPTED');
    expect(stopped.blocker?.message).toContain('Stopped between stages for a restart');
    // Nothing was cut off mid-stage.
    expect(t.services.store.listStages(id).map((x) => x.status)).not.toContain('INTERRUPTED');
    // New work does not start while draining.
    const queued = await createTask(t, await addRepo(t, await makeRepo()), 'Waits for the restart');
    expect(t.services.store.getTask(queued)!.status).toBe('QUEUED');
    await s.close();
    await t.close();

    t = await createTestApp({ dataDir });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(done.status).toBe('COMPLETED');
  }, 180_000);
});
