import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import { git } from '@acc/git';
import type { Execution, StageWorkUnit, WorkflowProfileInput } from '@acc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { clipTitle, parseWinner } from '../src/engine/stage-team.js';
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
  // Every test's first task is TASK-0001: a once-per-task marker ([sim:review-fail-once]) must fire again in the next test.
  SimulatedAgentAdapter.reset();
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

/** Three read-only assessors, two at a time: the third runs in a second wave. */
const ASSESS_THREE: WorkflowProfileInput = {
  id: 'assess-three',
  name: 'Assess three',
  stages: [
    {
      key: 'assess',
      name: 'Assessment',
      role: 'investigator',
      permissionLevel: 1,
      next: 'complete',
      team: { mode: 'fixed', maxWorkers: 2, workers: [{ key: 'arch', focus: 'Architecture' }, { key: 'risk', focus: 'Risks' }, { key: 'tests', focus: 'Tests to add' }] },
    },
  ],
};

/** A write team alone: a Fix split into units run at most two at a time, so three units take two waves. */
const FIX_ONLY: WorkflowProfileInput = {
  id: 'fix-only',
  name: 'Fix only',
  stages: [{ key: 'fix', name: 'Fix', role: 'fixer', permissionLevel: 2, next: 'complete', team: { mode: 'adaptive', maxWorkers: 2 } }],
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
const events = (taskId: string) => t!.services.store.listEvents(taskId, { limit: 2000 });
/** The stage-level event of a type for the first (or n-th) run of a stage. */
const stageEvent = (taskId: string, stageKey: string, type: string, run = 1) => {
  const stage = t!.services.store.listStages(taskId).filter((s) => s.stageKey === stageKey)[run - 1];
  return events(taskId).find((e) => e.type === type && e.stageId === stage?.id);
};
/** An artifact's text by its exact name. */
const artifactText = async (taskId: string, name: string) => {
  const rec = t!.services.store.listArtifacts(taskId).find((a) => a.name === name);
  expect(rec, name).toBeDefined();
  return (await t!.services.artifacts.read(rec!)).content;
};
const spellings = (p: string) => [p, p.replace(/\\/g, '/')];
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

    // Every team run saved the prompt it read, named after its unit (docs/systems/prompts.md).
    const names = t!.services.store.listArtifacts(id).map((a) => a.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'investigation-prompt-arch.md',
        'investigation-prompt-risk.md',
        'implementation-prompt-alpha.md',
        'implementation-prompt-beta.md',
        'implementation-prompt-integration.md',
        'review-prompt-full.md',
        'review-prompt-risk.md',
      ]),
    );
    // A writer's prompt names only its own checkout: never the task's worktree (where the lead ran), never the operator's folder.
    const alphaPrompt = await artifactText(id, 'implementation-prompt-alpha.md');
    expect(alphaPrompt).toContain(alpha.cwd);
    for (const outside of [...spellings(lead.cwd), ...spellings(repoPath)]) expect(alphaPrompt).not.toContain(outside);
    expect(alphaPrompt).toContain(`- Path: ${alpha.cwd}\n`);

    // The integration pass is recorded like any unit: the files before and after it, and what it changed.
    expect(impl[2]!.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(impl[2]!.resultCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(impl[2]!.baseCommit).not.toBe(impl[2]!.resultCommit);
    const implEvents = events(id).filter((e) => e.stageId === impl[0]!.stageId);
    expect(implEvents.map((e) => e.message)).toContain('Integration finished · 1 file changed');
    // The simulated lead writes sim-output.md, outside both units' paths: reported, not refused.
    expect(implEvents.some((e) => e.type === 'STAGE_TEAM' && /the integration pass changed 1 file outside the work units' paths \(sim-output\.md\)/.test(e.message))).toBe(true);

    // The stage's line credits each unit with its own work and the lead with its reconciliation; the aggregate names the lead's agent.
    const implStage = t!.services.store.getStage(impl[0]!.stageId)!;
    expect(implStage.summary).toMatch(/^Team of 2: Alpha part: .+; Beta part: .+; integration: .+$/);
    expect(await t!.services.artifacts.latestText(id, 'implementation-report')).toContain(`\n## Integration (lead, ${t!.services.agents.adapter(lead.agentId!).displayName})\n`);

    // Wall time and agent time side by side, with the lead's pass apart from the workers'.
    const implTeam = (stageEvent(id, 'implement', 'STAGE_COMPLETED')!.data as { team: Record<string, number | null> }).team;
    expect(implTeam).toMatchObject({ workers: 2, reused: 0, integrated: 2, decomposeMs: null });
    expect(implTeam.agentMs).toBeGreaterThan(0);
    expect(implTeam.integrationMs).toBeGreaterThan(0);
    expect(implTeam.wallMs).toBeGreaterThan(0);

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

  it('runs competing variants each in its own checkout and integrates only the one the judge keeps', async () => {
    const VARIANTS: WorkflowProfileInput = {
      id: 'variants',
      name: 'Variants',
      stages: [
        {
          key: 'build',
          name: 'Build',
          role: 'designer',
          permissionLevel: 2,
          next: 'complete',
          team: { mode: 'variants', maxWorkers: 3, workers: [{ key: 'bold', focus: 'Bold take' }, { key: 'calm', focus: 'Calm take' }, { key: 'dense', focus: 'Dense take' }], judge: { agentId: 'claude' } },
        },
      ],
    };
    const { repoId } = await setup([VARIANTS]);
    // The judge keeps the last variant listed; the first one crashes, which costs an approach, not the stage.
    const id = await createTask(t!, repoId, 'Restyle the page [sim:judge-last] [sim:fail-unit-once:bold]', { workflowId: 'variants', supervised: false });
    const task = await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(task.status, task.blocker?.message).toBe('COMPLETED');
    const build = units(id, 'build');
    expect(build.map((u) => [u.unitKey, u.kind, u.status])).toEqual([
      ['bold', 'worker', 'FAILED'],
      ['calm', 'worker', 'SUCCESS'],
      ['dense', 'worker', 'SUCCESS'],
      ['judge', 'judge', 'SUCCESS'],
    ]);
    expect(build.find((u) => u.unitKey === 'calm')!.summary).toMatch(/^Not chosen: /);
    expect(build.find((u) => u.unitKey === 'judge')!.summary).toMatch(/^Chose Dense take/);
    // Only the winner's files reached the task (its branch): its line in the shared file, its own file, nothing of calm's.
    const repoPath = t!.services.store.getRepository(repoId)!.path;
    const shown = await sh(repoPath, ['show', `${task.git.taskBranch}:sim-output.md`]);
    expect(shown.out).toMatch(/^- designer change by variant dense at /);
    expect((await sh(repoPath, ['show', `${task.git.taskBranch}:variant-dense.md`])).code).toBe(0);
    expect((await sh(repoPath, ['show', `${task.git.taskBranch}:variant-calm.md`])).code).not.toBe(0);
    // The judge ran read-only (Level 1) and saw each finished variant's diff, and only those.
    const judgePrompt = t!.services.store.listArtifacts(id).find((a) => a.name === 'design-prompt-judge.md');
    expect(judgePrompt).toBeDefined();
    const judgeText = readFileSync(path.isAbsolute(judgePrompt!.path) ? judgePrompt!.path : path.join(t!.dataDir, judgePrompt!.path), 'utf8');
    expect(judgeText).toMatch(/^Role: judge$/m);
    expect(judgeText).toContain('### Variant `calm`: Calm take');
    expect(judgeText).toContain('+- designer change by variant dense at');
    expect(judgeText).not.toContain('### Variant `bold`');
    // It ran in the task's own folder, which no variant touched, never in a variant's checkout.
    const judgeRun = agentExecs(id).find((e) => e.workUnitId === build.find((u) => u.unitKey === 'judge')!.id);
    expect(judgeRun?.cwd).toBeTruthy();
    expect(judgeRun!.cwd).not.toContain('team-worktrees');
    const report = await t!.services.artifacts.latestText(id, 'implementation-report');
    expect(report).toContain('## Variant kept: Dense take');
    expect(report).toContain('Kept over: Bold take (failed), Calm take');
    const stage = t!.services.store.latestStage(id, 'build')!;
    expect(stage.summary).toMatch(/^3 variants \(1 failed\); kept Dense take/);
  }, 60_000);

  it('keeps the judged read-only variant as the stage report, and fails the stage when the judge names none', async () => {
    const READ: WorkflowProfileInput = {
      id: 'read-variants',
      name: 'Read variants',
      stages: [{ key: 'direction', name: 'Art direction', role: 'art-director', permissionLevel: 1, next: 'complete', team: { mode: 'variants', maxWorkers: 2, workers: [{ key: 'warm', focus: 'Warm palette' }, { key: 'cool', focus: 'Cool palette' }] } }],
    };
    const { repoId } = await setup([READ]);
    const id = await createTask(t!, repoId, 'Pick a direction', { workflowId: 'read-variants', supervised: false });
    const task = await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(task.status, task.blocker?.message).toBe('COMPLETED');
    const plan = await t!.services.artifacts.latestText(id, 'plan');
    expect(plan).toContain('## Variant kept: Warm palette');
    expect(plan).toContain('## Media budget');
    const none = await createTask(t!, repoId, 'Pick again [sim:judge-none]', { workflowId: 'read-variants', supervised: false });
    const failed = await waitForStatus(t!, none, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(failed.status).toBe('FAILED');
    expect(failed.blocker?.message ?? t!.services.store.latestStage(none, 'direction')?.errorMessage).toMatch(/the judge did not end with a "WINNER: <key>" line/);
    expect(parseWinner('Reasons.\n\n**WINNER:** `calm`')).toBe('calm');
    expect(parseWinner('WINNER: a\nWINNER: b')).toBe('b');
    expect(parseWinner('then WINNER: b')).toBeNull();
    expect(parseWinner('no winner here')).toBeNull();
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

    // The FAIL carries the stage's timing and team data, and names the reviewer that asked for changes.
    const failed = stageEvent(id, 'review', 'REVIEW_FAILED')!;
    expect(failed.message).toMatch(/^Review requested changes \((The whole diff|Security and data risks)\)$/);
    expect(failed.data).toMatchObject({ verdict: 'FAIL', team: { workers: 2 } });
    expect(typeof failed.data.durationMs).toBe('number');

    // The decomposer and the lead finish on the timeline like any worker, and every run's prompt is saved.
    const fixMessages = events(id).filter((e) => e.type === 'WORK_UNIT' && e.stageId === fix[0]!.stageId).map((e) => e.message);
    expect(fixMessages).toContain('Split the fix finished · 2 units: Alpha part, Beta part');
    expect(fixMessages).toContain('Integration finished · 1 file changed');
    expect(t!.services.store.listArtifacts(id).map((a) => a.name)).toEqual(expect.arrayContaining(['fix-decomposition-prompt.md', 'fix-decomposition.md', 'fix-prompt-alpha.md', 'fix-prompt-beta.md', 'fix-prompt-integration.md']));
    const fixTeam = (stageEvent(id, 'fix', 'STAGE_COMPLETED')!.data as { team: Record<string, number | null> }).team;
    expect(fixTeam.decomposeMs).toBeGreaterThan(0);
    expect(fixTeam.integrationMs).toBeGreaterThan(0);
  }, 60_000);

  it('parks a supervised team at the task\'s own agent-run limit, and goes on once a resume extends it', async () => {
    const { repoPath, repoId } = await setup([ASSESS_THREE]);
    // As Git for Windows sets it: the task's files are CRLF on disk and LF in Git.
    await sh(repoPath, ['config', 'core.autocrlf', 'true']);
    // The task's own limit, below the global setting (which allows 60 runs and never changes here).
    const withRuns = async (description: string, maxAgentRuns: number) => {
      const taskId = await createTask(t!, repoId, description, { workflowId: 'assess-three', supervised: true, start: false });
      const limits = t!.services.store.getTask(taskId)!.limits!;
      t!.services.store.updateTask(taskId, { limits: { ...limits, maxAgentRuns } });
      await t!.services.engine.start(taskId);
      return taskId;
    };
    expect(t!.services.settings.get().chairman.maxAgentRuns).toBeGreaterThan(3);
    const id = await withRuns('Assess in two waves', 2);
    const parked = await waitForStatus(t!, id, ['WAITING_FOR_USER', 'COMPLETED', 'FAILED'], 60_000);
    // A limit, as before any stage — not an error — and the third worker never started.
    expect(parked.blocker).toMatchObject({ kind: 'limit', stageKey: 'assess' });
    expect(parked.blocker!.message).toBe('Agent run limit reached (2 of 2).');
    expect(units(id).map((u) => [u.unitKey, u.status])).toEqual([
      ['arch', 'SUCCESS'],
      ['risk', 'SUCCESS'],
      ['tests', 'CANCELLED'],
    ]);
    expect(agentExecs(id).length).toBe(2);
    expect(events(id).some((e) => e.type === 'TASK_WAITING' && e.message.startsWith('Paused at a limit: Agent run limit reached'))).toBe(true);

    // A plain `git status` in the task's folder (a real worker, the operator's editor) refreshes its index: the files are still the same files.
    const env = { ...process.env };
    delete env.GIT_OPTIONAL_LOCKS;
    execFileSync('git', ['status', '--porcelain'], { cwd: parked.git.worktreePath ?? repoPath, env });

    // Resuming extends this task's limits; the stage runs again and reuses the first wave.
    expect((await t!.api('POST', `/api/tasks/${id}/resume`)).status).toBe(200);
    const done = await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.blocker?.message ?? null).toBeNull();
    expect(done.status).toBe('COMPLETED');
    expect(done.limits!.maxAgentRuns).toBeGreaterThan(2);
    expect(units(id).slice(3).map((u) => [u.unitKey, u.status])).toEqual([
      ['arch', 'REUSED'],
      ['risk', 'REUSED'],
      ['tests', 'SUCCESS'],
    ]);
    expect(t!.services.store.listStages(id).map((s) => s.status)).toEqual(['CANCELLED', 'SUCCESS']);
    expect(agentExecs(id).length).toBe(3);

    // A wave that would not fit in the runs left does not start at all: no worker is started only to be wasted.
    const second = await withRuns('Assess with one run left', 1);
    const waiting = await waitForStatus(t!, second, ['WAITING_FOR_USER', 'COMPLETED', 'FAILED'], 60_000);
    expect(waiting.blocker).toMatchObject({ kind: 'limit', message: 'Agent run limit reached for Assessment: it needs 2 more agent runs, and 1 of 1 is left.' });
    expect(agentExecs(second)).toEqual([]);
    expect(units(second).map((u) => u.status)).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);
  }, 90_000);

  it('parks a write team after a wave was integrated, and on resume reuses the split and that wave instead of redoing it', async () => {
    const { repoId } = await setup([FIX_ONLY]);
    const id = await createTask(t!, repoId, 'Three repairs [sim:team] [sim:team-three]', { workflowId: 'fix-only', supervised: true, start: false });
    // The split and the first wave (alpha, beta) fit; the second wave (gamma) and the lead's pass after it do not.
    t!.services.store.updateTask(id, { limits: { ...t!.services.store.getTask(id)!.limits!, maxAgentRuns: 4 } });
    await t!.services.engine.start(id);
    const parked = await waitForStatus(t!, id, ['WAITING_FOR_USER', 'COMPLETED', 'FAILED'], 60_000);
    expect(parked.blocker).toMatchObject({ kind: 'limit', stageKey: 'fix', message: 'Agent run limit reached for Fix: it needs 2 more agent runs, and 1 of 4 is left.' });
    expect(units(id).map((u) => [u.kind, u.unitKey, u.status])).toEqual([
      ['decomposer', 'decompose', 'SUCCESS'],
      ['worker', 'alpha', 'SUCCESS'],
      ['worker', 'beta', 'SUCCESS'],
      ['worker', 'gamma', 'CANCELLED'],
    ]);
    // The first wave is already in the task's files while it waits.
    const fixerLines = (text: string) => text.split('\n').filter((l) => l.includes('fixer change')).length;
    const worktree = parked.git.worktreePath!;
    expect(['team-a/sim-alpha.md', 'team-b/sim-beta.md'].map((f) => fixerLines(readFileSync(path.join(worktree, f), 'utf8')))).toEqual([1, 1]);

    expect((await t!.api('POST', `/api/tasks/${id}/resume`)).status).toBe(200);
    const done = await waitForStatus(t!, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.blocker?.message ?? null).toBeNull();
    expect(done.status).toBe('COMPLETED');
    expect(t!.services.store.listStages(id).map((s) => s.status)).toEqual(['CANCELLED', 'SUCCESS']);
    // Same failures, same split: nothing is split again, and what the first run integrated is not redone.
    const resumed = units(id).slice(4);
    expect(resumed.map((u) => [u.kind, u.unitKey, u.status])).toEqual([
      ['decomposer', 'decompose', 'REUSED'],
      ['worker', 'alpha', 'REUSED'],
      ['worker', 'beta', 'REUSED'],
      ['worker', 'gamma', 'SUCCESS'],
      ['integration', 'integration', 'SUCCESS'],
    ]);
    expect(resumed[1]!.reusedFrom).toBe(units(id)[1]!.id);
    // An integrated unit keeps the base its result was made on.
    expect([resumed[1]!.baseCommit, resumed[1]!.resultCommit]).toEqual([units(id)[1]!.baseCommit, units(id)[1]!.resultCommit]);
    const messages = events(id).filter((e) => e.stageId === resumed[0]!.stageId).map((e) => e.message);
    expect(messages).toContain('Split the fix: reused its earlier result (the same failures, split before the run stopped)');
    expect(messages).toContain("Alpha part: reused its earlier result (already in the task's files)");
    // One run each: the decomposer, alpha and beta before the limit; gamma and the lead after it.
    const runsOf = (key: string) => agentExecs(id).filter((e) => units(id).some((u) => u.id === e.workUnitId && u.unitKey === key)).length;
    expect(['decompose', 'alpha', 'beta', 'gamma', 'integration'].map(runsOf)).toEqual([1, 1, 1, 1, 1]);
    expect(agentExecs(id).length).toBe(5);
    const fixTeam = (stageEvent(id, 'fix', 'STAGE_COMPLETED', 2)!.data as { team: Record<string, number | null> }).team;
    expect(fixTeam).toMatchObject({ workers: 3, reused: 2, integrated: 3, decomposeMs: null });

    // Every unit's change is in the task exactly once.
    for (const file of ['team-a/sim-alpha.md', 'team-b/sim-beta.md', 'team-c/sim-gamma.md']) {
      const shown = await sh(t!.services.store.getRepository(repoId)!.path, ['show', `${done.git.taskBranch}:${file}`]);
      expect(shown.code, file).toBe(0);
      expect(fixerLines(shown.out), file).toBe(1);
    }
  }, 90_000);

  it('keeps every built-in worker focus short enough to be its title, and clips a long one at a word', async () => {
    t = await createTestApp();
    const builtins = t.services.workflows.list().filter((w) => w.builtin);
    expect(builtins.map((w) => w.id)).toEqual(expect.arrayContaining(['architecture', 'full-autopilot']));
    const focuses = builtins.flatMap((w) => w.stages.flatMap((s) => (s.team?.workers ?? []).map((wk) => `${w.id}/${s.key}/${wk.key}: ${wk.focus}`)));
    expect(focuses.length).toBeGreaterThan(0);
    for (const f of focuses) expect(f.slice(f.indexOf(': ') + 2).length, f).toBeLessThanOrEqual(60);
    expect(clipTitle('The code involved, root cause and the smallest fitting change')).toBe('The code involved, root cause and the smallest fitting…');
    expect(clipTitle('Short focus')).toBe('Short focus');
    expect(clipTitle('x'.repeat(80))).toBe(`${'x'.repeat(59)}…`);
  });

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
