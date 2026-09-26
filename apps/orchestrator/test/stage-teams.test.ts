import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '@acc/git';
import type { Execution, StageWorkUnit, WorkflowProfileInput } from '@acc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { newId, now } from '../src/store/store.js';
import { addRepo, createTask, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from './helpers.js';

/**
 * Stage Teams end to end with simulated agents (docs/plans/STAGE_TEAMS_PLAN.md
 * §7.4–7.7): real repositories, real worktrees, the real workflow loop.
 */

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const FULL: WorkflowProfileInput = {
  id: 'team-flow',
  name: 'Team flow',
  maxFixCycles: 2,
  stages: [
    { key: 'assess', name: 'Assessment', role: 'investigator', permissionLevel: 1, next: 'plan', team: { mode: 'fixed', maxWorkers: 2, workers: [{ key: 'arch', focus: 'Architecture' }, { key: 'risk', focus: 'Risks', agentId: 'claude' }] } },
    { key: 'plan', name: 'Plan', role: 'planner', permissionLevel: 1, next: 'implement' },
    { key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, next: 'test', retry: { maxAttempts: 2 }, team: { mode: 'adaptive', maxWorkers: 3 } },
    { key: 'test', name: 'Test', role: 'tester', kind: 'tests', permissionLevel: 2, next: 'review', onFail: 'fix' },
    {
      key: 'review',
      name: 'Review',
      role: 'reviewer',
      permissionLevel: 1,
      verdict: true,
      next: 'complete',
      onFail: 'fix',
      team: { mode: 'fixed', maxWorkers: 2, workers: [{ key: 'full', focus: 'The whole diff', primary: true }, { key: 'risk', focus: 'Security and data risks' }] },
    },
    { key: 'fix', name: 'Fix', role: 'fixer', permissionLevel: 2, next: 'test', team: { mode: 'adaptive', maxWorkers: 2 } },
  ],
};

/** A read-only team alone: two assessors, then done. */
const ASSESS: WorkflowProfileInput = {
  id: 'assess-team',
  name: 'Assess team',
  stages: [{ key: 'assess', name: 'Assessment', role: 'investigator', permissionLevel: 1, next: 'complete', retry: { maxAttempts: 2 }, team: { mode: 'fixed', maxWorkers: 2, workers: [{ key: 'arch', focus: 'Architecture' }, { key: 'risk', focus: 'Risks' }] } }],
};

async function setup(workflows: WorkflowProfileInput[] = [FULL], settings: Record<string, unknown> = {}) {
  t = await createTestApp();
  for (const wf of workflows) {
    const res = await t.api('PUT', `/api/workflows/${wf.id}`, wf);
    if (res.status !== 200) throw new Error(`workflow: ${JSON.stringify(res.body)}`);
  }
  const repoPath = await makeRepo();
  const repoId = await addRepo(t, repoPath, settings);
  return { repoPath, repoId };
}

const units = (taskId: string, stageKey?: string): StageWorkUnit[] => t!.services.store.listWorkUnits(taskId).filter((u) => !stageKey || u.stageKey === stageKey);
const agentExecs = (taskId: string): Execution[] => t!.services.store.listExecutions(taskId).filter((e) => e.kind === 'agent');
const span = (e: Execution) => [new Date(e.startedAt).getTime(), new Date(e.finishedAt!).getTime()] as const;
const overlaps = (a: Execution, b: Execution) => span(a)[0] < span(b)[1] && span(b)[0] < span(a)[1];

async function sh(cwd: string, args: string[]) {
  const r = await git(cwd, args);
  return { code: r.code, out: r.stdout.trim() };
}

describe('Stage Teams', () => {
  it('runs a whole workflow with teams: parallel assessment, isolated writers integrated once, deterministic tests, a review team', async () => {
    const { repoPath, repoId } = await setup();
    const id = await createTask(t!, repoId, 'Build both halves [sim:team]', { workflowId: 'team-flow', supervised: false });
    const task = await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(task.blocker?.message ?? null).toBeNull();
    expect(task.status).toBe('COMPLETED');
    expect(task.finalStatus).toBe('READY');

    // Assessment: two read-only workers — one on the stage's agent, one pinned to its own — and one aggregate report.
    const assess = units(id, 'assess');
    const stageAgent = (await t!.api('GET', `/api/tasks/${id}`)).body.assignments.assess.agentId;
    expect(assess.map((u) => [u.unitKey, u.status, u.agentId])).toEqual([
      ['arch', 'SUCCESS', stageAgent],
      ['risk', 'SUCCESS', 'claude'],
    ]);
    const artifacts = t!.services.store.listArtifacts(id).map((a) => a.name);
    expect(artifacts).toEqual(expect.arrayContaining(['investigation.md', 'investigation-arch.md', 'investigation-risk.md']));
    const investigation = await t!.services.artifacts.latestText(id, 'investigation');
    expect(investigation).toContain('## Architecture');
    expect(investigation).toContain('## Risks');

    // Implement: two writers from the plan's manifest, each in its own checkout, then one integration pass.
    const impl = units(id, 'implement');
    expect(impl.map((u) => [u.kind, u.unitKey, u.status])).toEqual([
      ['worker', 'alpha', 'SUCCESS'],
      ['worker', 'beta', 'SUCCESS'],
      ['integration', 'integration', 'SUCCESS'],
    ]);
    const execs = agentExecs(id);
    const alpha = execs.find((e) => e.workUnitId === impl[0]!.id)!;
    const beta = execs.find((e) => e.workUnitId === impl[1]!.id)!;
    const lead = execs.find((e) => e.workUnitId === impl[2]!.id)!;
    const teamRoot = path.join(t!.dataDir, 'team-worktrees');
    expect(alpha.cwd.startsWith(teamRoot)).toBe(true);
    expect(beta.cwd.startsWith(teamRoot)).toBe(true);
    expect(alpha.cwd).not.toBe(beta.cwd);
    expect(lead.cwd.startsWith(teamRoot)).toBe(false);
    expect(impl[0]!.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(impl[0]!.resultCommit).toMatch(/^[0-9a-f]{40}$/);

    // Both halves are on the task branch; the operator's checkout never saw any of it.
    const branch = task.git.taskBranch!;
    expect((await sh(repoPath, ['show', `${branch}:team-a/sim-alpha.md`])).code).toBe(0);
    expect((await sh(repoPath, ['show', `${branch}:team-b/sim-beta.md`])).code).toBe(0);
    expect((await sh(repoPath, ['branch', '--show-current'])).out).toBe('main');
    expect((await sh(repoPath, ['status', '--porcelain'])).out).toBe('');
    expect(existsSync(path.join(repoPath, 'team-a'))).toBe(false);

    // The deterministic tests ran after the integrated change, and the review team saw the combined diff.
    const stages = t!.services.store.listStages(id);
    const implDone = stages.find((s) => s.stageKey === 'implement')!;
    const testStage = stages.find((s) => s.stageKey === 'test')!;
    expect(testStage.status).toBe('SUCCESS');
    expect(testStage.createdAt >= implDone.finishedAt!).toBe(true);
    expect(units(id, 'review').map((u) => [u.unitKey, u.primary, u.status])).toEqual([
      ['full', true, 'SUCCESS'],
      ['risk', false, 'SUCCESS'],
    ]);
    const reviewPrompt = await t!.services.artifacts.latestText(id, 'stage-output');
    expect(reviewPrompt).not.toBeNull();

    // Every worker went through the usage ledger, attributed to its unit, and none counts as a retry of a sibling.
    const usage = t!.services.usage.queries.taskEvents(id);
    const alphaUsage = usage.find((e) => e.workUnitKey === 'alpha')!;
    const betaUsage = usage.find((e) => e.workUnitKey === 'beta')!;
    expect(alphaUsage.workflowStep).toBe('implement');
    expect([alphaUsage.retryIndex, betaUsage.retryIndex]).toEqual([0, 0]);
    expect(usage.length).toBe(execs.length);
    // The Chairman's agent-run count includes every worker.
    expect(t!.services.chairman.store.usage(id).agentRuns).toBe(execs.length);

    // Nothing the team made outlives the task: no hidden result refs, no child checkouts.
    expect((await sh(repoPath, ['for-each-ref', `refs/acc/team/${id}/`])).out).toBe('');
    expect(existsSync(path.join(teamRoot, id))).toBe(false);

    // The API and the task detail both expose the units.
    const api = await t!.api('GET', `/api/tasks/${id}/work-units`);
    expect(api.status).toBe(200);
    expect(api.body.length).toBe(units(id).length);
    expect((await t!.api('GET', `/api/tasks/${id}`)).body.workUnits.length).toBe(units(id).length);
    expect((await t!.api('GET', '/api/tasks/TASK-9999/work-units')).status).toBe(404);
  }, 90_000);

  it('runs two read-only workers at the same time, well under the sequential time', async () => {
    const { repoId } = await setup([ASSESS]);
    const id = await createTask(t!, repoId, 'Assess slowly [sim:slow]', { workflowId: 'assess-team', supervised: false });
    await waitForStatus(t!, id, ['COMPLETED', 'FAILED'], 60_000);
    const [a, b] = agentExecs(id);
    expect(a && b && overlaps(a, b)).toBe(true);
    const stage = t!.services.store.listStages(id)[0]!;
    const wall = new Date(stage.finishedAt!).getTime() - new Date(stage.startedAt!).getTime();
    const sequential = a!.durationMs! + b!.durationMs!;
    expect(wall).toBeLessThanOrEqual(sequential * 0.7);
    const completed = t!.services.store.listEvents(id, { limit: 500 }).find((e) => e.type === 'STAGE_COMPLETED')!;
    expect(completed.data).toMatchObject({ team: { workers: 2, reused: 0 } });
  }, 60_000);

  it('runs the stage as one agent when the plan does not split the work', async () => {
    const { repoId } = await setup();
    const id = await createTask(t!, repoId, 'A small cohesive change', { workflowId: 'team-flow', supervised: false });
    const task = await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(task.status).toBe('COMPLETED');
    expect(units(id, 'implement')).toEqual([]);
    const events = t!.services.store.listEvents(id, { limit: 1000 });
    expect(events.some((e) => e.type === 'STAGE_TEAM' && /Implement runs as one agent: the plan has no work-unit manifest/.test(e.message))).toBe(true);
  }, 60_000);

  it('never parallelises writers whose paths overlap', async () => {
    const { repoId } = await setup();
    const id = await createTask(t!, repoId, 'Both touch shared [sim:team] [sim:team-overlap]', { workflowId: 'team-flow', supervised: false });
    await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(units(id, 'implement')).toEqual([]);
    const events = t!.services.store.listEvents(id, { limit: 1000 });
    expect(events.some((e) => e.type === 'STAGE_TEAM' && /units alpha and beta claim the same paths/.test(e.message))).toBe(true);
  }, 60_000);

  it('fails a worker that changes files outside its paths, and integrates nothing from that wave', async () => {
    const { repoId } = await setup();
    const id = await createTask(t!, repoId, 'Stray write [sim:team] [sim:team-out-of-scope]', { workflowId: 'team-flow', supervised: false });
    const task = await waitForStatus(t!, id, ['FAILED', 'WAITING_FOR_USER', 'COMPLETED'], 60_000);
    expect(task.status).toBe('FAILED');
    expect(task.blocker?.message).toMatch(/Beta part: changed 1 file\(s\) outside the paths it owns \(sim-output.md\); none of its work was used/);
    const latest = units(id, 'implement').filter((u) => u.kind === 'worker').slice(-2);
    expect(latest.map((u) => [u.unitKey, u.status, u.errorClass])).toEqual([
      ['alpha', 'REUSED', null],
      ['beta', 'FAILED', 'SCOPE_VIOLATION'],
    ]);
    // The task's worktree holds none of the team's work: not alpha's, not beta's.
    const worktree = task.git.worktreePath!;
    expect(existsSync(path.join(worktree, 'team-a'))).toBe(false);
    expect(existsSync(path.join(worktree, 'team-b'))).toBe(false);
    expect(existsSync(path.join(worktree, 'sim-output.md'))).toBe(false);
  }, 60_000);

  it('runs dependent units in a later wave, on top of what the first wave integrated', async () => {
    const { repoId } = await setup();
    const id = await createTask(t!, repoId, 'Three parts, beta after alpha [sim:team] [sim:team-three] [sim:team-chain]', { workflowId: 'team-flow', supervised: false });
    const task = await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(task.status).toBe('COMPLETED');
    const impl = units(id, 'implement');
    const byKey = Object.fromEntries(impl.map((u) => [u.unitKey, u]));
    expect(byKey.beta!.startedAt! >= byKey.alpha!.finishedAt!).toBe(true);
    // Wave 2 started from a checkpoint that already contained wave 1.
    expect(byKey.beta!.baseCommit).not.toBe(byKey.alpha!.baseCommit);
    const integrated = t!.services.store.listEvents(id, { limit: 1000 }).filter((e) => e.type === 'STAGE_TEAM' && /integrated/.test(e.message));
    expect(integrated.length).toBe(2);
  }, 60_000);

  it('never runs more workers at once than the stage allows', async () => {
    const capped: WorkflowProfileInput = { ...FULL, id: 'team-capped', stages: FULL.stages.map((s) => (s.key === 'implement' ? { ...s, team: { mode: 'adaptive' as const, maxWorkers: 2 } } : s.team ? { ...s, team: undefined } : s)) };
    const { repoId } = await setup([capped]);
    const id = await createTask(t!, repoId, 'Three parts [sim:team] [sim:team-three] [sim:slow]', { workflowId: 'team-capped', supervised: false });
    await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 120_000);
    const workers = units(id, 'implement').filter((u) => u.kind === 'worker');
    expect(workers.length).toBe(3);
    const execs = agentExecs(id).filter((e) => workers.some((w) => w.id === e.workUnitId));
    for (const e of execs) expect(execs.filter((o) => overlaps(o, e)).length).toBeLessThanOrEqual(2);
  }, 120_000);

  it('stops every worker on cancel and leaves nothing running', async () => {
    const { repoId } = await setup([ASSESS]);
    const id = await createTask(t!, repoId, 'Assess slowly [sim:slow]', { workflowId: 'assess-team', supervised: false });
    await waitFor(() => t!.services.store.listExecutions(id).filter((e) => e.status === 'running').length, (n) => n === 2, 20_000, 'two workers running');
    expect((await t!.api('POST', `/api/tasks/${id}/cancel`, {})).status).toBe(200);
    await waitForStatus(t!, id, ['CANCELLED'], 20_000);
    expect(t!.services.store.listExecutions(id).map((e) => e.status)).toEqual(['cancelled', 'cancelled']);
    expect(units(id).map((u) => u.status)).toEqual(['CANCELLED', 'CANCELLED']);
  }, 60_000);

  it('reuses a worker that already succeeded when the stage is retried, and reruns only the one that failed', async () => {
    const { repoId } = await setup([ASSESS]);
    const id = await createTask(t!, repoId, 'Assess [sim:fail-unit-once:risk]', { workflowId: 'assess-team', supervised: false });
    const task = await waitForStatus(t!, id, ['COMPLETED', 'FAILED'], 60_000);
    expect(task.status).toBe('COMPLETED');
    const all = units(id);
    expect(all.map((u) => [u.unitKey, u.attempt, u.status])).toEqual([
      ['arch', 1, 'SUCCESS'],
      ['risk', 1, 'FAILED'],
      ['arch', 2, 'REUSED'],
      ['risk', 2, 'SUCCESS'],
    ]);
    expect(all[2]!.reusedFrom).toBe(all[0]!.id);
    // arch ran once; risk twice.
    const runsOf = (key: string) => agentExecs(id).filter((e) => all.some((u) => u.id === e.workUnitId && u.unitKey === key)).length;
    expect([runsOf('arch'), runsOf('risk')]).toEqual([1, 2]);
  }, 60_000);

  it('reuses a write unit whose result is proven for the same files, after a sibling crashed', async () => {
    const { repoId } = await setup();
    const id = await createTask(t!, repoId, 'Two halves [sim:team] [sim:fail-unit-once:beta]', { workflowId: 'team-flow', supervised: false });
    const task = await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(task.status).toBe('COMPLETED');
    const workers = units(id, 'implement').filter((u) => u.kind === 'worker');
    expect(workers.map((u) => [u.unitKey, u.status])).toEqual([
      ['alpha', 'SUCCESS'],
      ['beta', 'FAILED'],
      ['alpha', 'REUSED'],
      ['beta', 'SUCCESS'],
    ]);
    expect(workers[2]!.resultCommit).toBe(workers[0]!.resultCommit);
    expect((await sh(t!.services.store.getRepository(repoId)!.path, ['show', `${task.git.taskBranch}:team-a/sim-alpha.md`])).code).toBe(0);
  }, 60_000);

  it('sends a review team FAIL to the fix route, where the failures are decomposed first', async () => {
    const { repoId } = await setup();
    const id = await createTask(t!, repoId, 'Needs one more round [sim:team] [sim:review-fail-once]', { workflowId: 'team-flow', supervised: false });
    const task = await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(task.status).toBe('COMPLETED');
    const reviews = t!.services.store.listStages(id).filter((s) => s.stageKey === 'review');
    expect(reviews.map((s) => s.verdict)).toEqual(['FAIL', 'PASS']);
    const fix = units(id, 'fix');
    expect(fix.map((u) => [u.kind, u.unitKey, u.status])).toEqual([
      ['decomposer', 'decompose', 'SUCCESS'],
      ['worker', 'alpha', 'SUCCESS'],
      ['worker', 'beta', 'SUCCESS'],
      ['integration', 'integration', 'SUCCESS'],
    ]);
  }, 60_000);

  it('runs the built-in Architecture workflow with its teams: both assessments at once, then a split implementation', async () => {
    t = await createTestApp();
    const wf = t.services.workflows.get('architecture');
    expect(wf.stages.map((s) => [s.key, s.team?.mode ?? null])).toEqual([
      ['assess', 'fixed'],
      ['plan', null],
      ['implement', 'adaptive'],
      ['test', null],
      ['review', 'fixed'],
      ['fix', 'adaptive'],
    ]);
    const repoId = await addRepo(t, await makeRepo());
    const id = await createTask(t, repoId, 'Restructure both halves [sim:team] [sim:slow]', { workflowId: 'architecture', supervised: false });
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 180_000);
    expect(task.status).toBe('COMPLETED');
    expect(task.finalStatus).toBe('READY');
    const assessRuns = agentExecs(id).filter((e) => units(id, 'assess').some((u) => u.id === e.workUnitId));
    expect(assessRuns.map((e) => e.agentId).sort()).toEqual(['claude', 'codex']);
    expect(overlaps(assessRuns[0]!, assessRuns[1]!)).toBe(true);
    expect(units(id, 'implement').filter((u) => u.kind === 'worker').map((u) => u.status)).toEqual(['SUCCESS', 'SUCCESS']);
  }, 200_000);

  it('runs the built-in Full Autopilot with its teams through every gate to a committed, READY task', async () => {
    t = await createTestApp();
    expect(t.services.workflows.get('full-autopilot').stages.filter((s) => s.team).map((s) => [s.key, s.team!.mode])).toEqual([
      ['investigate', 'fixed'],
      ['implement', 'adaptive'],
      ['review', 'fixed'],
      ['fix', 'adaptive'],
    ]);
    const repoPath = await makeRepo();
    const repoId = await addRepo(t, repoPath);
    const id = await createTask(t, repoId, 'Build both halves [sim:team] [sim:review-fail-once]', { workflowId: 'full-autopilot', supervised: false });
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 120_000);
    expect(task.blocker?.message ?? null).toBeNull();
    expect(task.status).toBe('COMPLETED');
    expect(task.finalStatus).toBe('READY');
    expect(units(id, 'investigate').map((u) => u.unitKey)).toEqual(['code', 'risks']);
    expect(units(id, 'implement').map((u) => [u.kind, u.status])).toEqual([
      ['worker', 'SUCCESS'],
      ['worker', 'SUCCESS'],
      ['integration', 'SUCCESS'],
    ]);
    // Review failed once with a team, the fix was split and integrated, and every later gate still ran.
    const stages = t.services.store.listStages(id);
    expect(stages.filter((s) => s.stageKey === 'review').map((s) => s.verdict)).toEqual(['FAIL', 'PASS']);
    expect(units(id, 'fix').some((u) => u.kind === 'worker' && u.status === 'SUCCESS')).toBe(true);
    expect(stages.find((s) => s.stageKey === 'verify')?.status).toBe('SUCCESS');
    expect(stages.find((s) => s.stageKey === 'git')?.status).toBe('SUCCESS');
    expect((await sh(repoPath, ['show', `${task.git.taskBranch}:team-a/sim-alpha.md`])).code).toBe(0);
  }, 150_000);

  it('after a restart, marks units that were running as interrupted and sweeps their partial checkouts without following shared links', async () => {
    const { repoId } = await setup([ASSESS]);
    const id = await createTask(t!, repoId, 'Parked', { workflowId: 'assess-team', start: false, supervised: false });
    const stageId = newId();
    const base = { taskId: id, stageId, stageKey: 'assess', kind: 'worker' as const, title: 'X', focus: 'X', ordinal: 0, dependencies: [], pathScope: [], primary: false, manifestHash: null, baseCommit: null, resultCommit: null, agentId: 'claude', model: null, effort: null, attempt: 1, reusedFrom: null, summary: null, errorClass: null, errorMessage: null, startedAt: now(), finishedAt: null, createdAt: now() };
    t!.services.store.insertWorkUnit({ ...base, id: newId(), unitKey: 'running', status: 'RUNNING' });
    t!.services.store.insertWorkUnit({ ...base, id: newId(), unitKey: 'queued', status: 'QUEUED' });
    // A partial child checkout with a shared-dependency link, as a crash would leave it.
    const shared = mkdtempSync(path.join(os.tmpdir(), 'acc-shared-deps-'));
    writeFileSync(path.join(shared, 'keep.txt'), 'must survive');
    const child = path.join(t!.dataDir, 'team-worktrees', id, 'abc-running');
    mkdirSync(child, { recursive: true });
    symlinkSync(shared, path.join(child, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

    t!.services.engine.recover();
    expect(units(id).map((u) => [u.unitKey, u.status, u.errorClass])).toEqual([
      ['running', 'FAILED', 'INTERRUPTED'],
      ['queued', 'CANCELLED', null],
    ]);
    expect(await t!.services.engine.team.sweep(t!.services.store.listRepositories())).toBe(1);
    expect(existsSync(child)).toBe(false);
    expect(readFileSync(path.join(shared, 'keep.txt'), 'utf8')).toBe('must survive');
  });
});

describe('parallel-safe checks', () => {
  const sleepy = (ms: number, code = 0) => `node -e "setTimeout(() => { console.log('1 passed'); process.exit(${code}); }, ${ms})"`;

  async function withCommands(commands: Array<Record<string, unknown>>) {
    t = await createTestApp();
    const repoPath = await makeRepo();
    return addRepo(t, repoPath, { commands, preexistingFailures: 'block' });
  }

  it('keeps commands in order, one at a time, unless marked parallel-safe', async () => {
    const repoId = await withCommands([
      { id: 'lint', name: 'lint', command: sleepy(700), kind: 'lint', enabled: true, timeoutSec: 60 },
      { id: 'types', name: 'types', command: sleepy(710), kind: 'typecheck', enabled: true, timeoutSec: 60 },
    ]);
    const id = await createTask(t!, repoId, 'Sequential checks', { supervised: false, workflowId: 'quick-change' });
    await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    const cmds = t!.services.store.listExecutions(id).filter((e) => e.kind === 'command');
    expect(cmds.length).toBe(2);
    expect(overlaps(cmds[0]!, cmds[1]!)).toBe(false);
  }, 60_000);

  it('runs parallel-safe checks together and stops the rest of the batch at the first real failure', async () => {
    const repoId = await withCommands([
      { id: 'lint', name: 'lint', command: sleepy(800), kind: 'lint', enabled: true, timeoutSec: 60, parallelSafe: true },
      { id: 'types', name: 'types', command: sleepy(810), kind: 'typecheck', enabled: true, timeoutSec: 60, parallelSafe: true },
    ]);
    const id = await createTask(t!, repoId, 'Parallel checks', { supervised: false, workflowId: 'quick-change' });
    const task = await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(task.status).toBe('COMPLETED');
    const cmds = t!.services.store.listExecutions(id).filter((e) => e.kind === 'command');
    expect(overlaps(cmds[0]!, cmds[1]!)).toBe(true);
    // Each check keeps its own execution and test run.
    expect(t!.services.store.listTestRuns(id).map((r) => [r.name, r.status])).toEqual([
      ['lint', 'passed'],
      ['types', 'passed'],
    ]);
    await t!.close();

    const failing = await withCommands([
      { id: 'lint', name: 'lint', command: sleepy(100, 1), kind: 'lint', enabled: true, timeoutSec: 60, parallelSafe: true },
      { id: 'types', name: 'types', command: sleepy(20_000), kind: 'typecheck', enabled: true, timeoutSec: 60, parallelSafe: true },
    ]);
    const second = await createTask(t!, failing, 'Parallel checks that fail', { supervised: false, workflowId: 'quick-change', maxFixCycles: 0 });
    await waitForStatus(t!, second, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    const runs = t!.services.store.listTestRuns(second).slice(0, 2);
    expect(runs.map((r) => [r.name, r.status])).toEqual([
      ['lint', 'failed'],
      ['types', 'not_run'],
    ]);
    expect(runs[1]!.summary).toBe('Stopped: lint failed first');
    const types = t!.services.store.listExecutions(second).find((e) => e.kind === 'command' && e.command.includes('20000'))!;
    expect(types.status).toBe('cancelled');
    expect(types.durationMs!).toBeLessThan(15_000);
  }, 90_000);
});
