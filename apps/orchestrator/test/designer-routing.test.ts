import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import type { StageInstance, WorkflowProfile } from '@acc/shared';
import { completionGate } from '../src/chairman/gate.js';
import { buildFinalReport } from '../src/engine/report.js';
import { guardRemoteCommand, type GuardContext } from '../src/remote/guards.js';
import { addRepo, createTask, createTestApp, IN_PLACE, makeRepo, waitForStatus, type TestApp } from './helpers.js';

/** Full Autopilot brings in the design specialist only for user-interface work (docs/plans/DESIGNER_ROUTING_PLAN.md). */

let t: TestApp;
beforeEach(async () => {
  SimulatedAgentAdapter.reset();
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

async function artifact(taskId: string, name: string, which: 'first' | 'last' = 'last'): Promise<string> {
  const recs = t.services.store.listArtifacts(taskId).filter((a) => a.name === name);
  const rec = which === 'first' ? recs[0] : recs.at(-1);
  if (!rec) throw new Error(`no artifact ${name}`);
  return (await t.services.artifacts.read(rec, 2_000_000)).content;
}

const stagesOf = (id: string, key: string) => t.services.store.listStages(id).filter((s) => s.stageKey === key);
const runsOf = (id: string, key: string) => {
  const ids = new Set(stagesOf(id, key).map((s) => s.id));
  return t.services.store.listExecutions(id).filter((e) => e.stageId !== null && ids.has(e.stageId));
};

describe('Full Autopilot: the visual critique runs only for user-interface work', () => {
  it('skips the critique on a backend task: no agent runs, nothing is asked, the gate and the report agree', async () => {
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'Tidy the API handler', { workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.supervised).toBe(true);

    const [critique, ...more] = stagesOf(id, 'critique');
    expect(more).toHaveLength(0);
    expect(critique).toMatchObject({ status: 'SKIPPED', agentId: null, verdict: null, summary: 'Skipped: No user-interface files changed in this task' });
    expect(runsOf(id, 'critique')).toHaveLength(0);
    expect(stagesOf(id, 'design-fix')).toHaveLength(0);
    // A skipped stage never "started": the timeline credits no agent with it.
    const events = t.services.store.listEvents(id, { limit: 500 }).filter((e) => e.stageId === critique!.id);
    expect(events.map((e) => e.type)).toEqual(['STAGE_SKIPPED']);
    expect(events[0]!.data).toMatchObject({ when: 'ui-changed', uiChanged: false });
    expect(t.services.store.listApprovals({ limit: 10 })).toHaveLength(0);

    const report = await artifact(id, 'final-report.md');
    expect(report).toContain('- Visual critique: not needed — no user-interface files changed in this task');
    expect(report).not.toContain('Completion check not met');
    expect(report).toContain('READY');
  }, 120_000);

  it('judges a UI change, sends a failed critique to the Level 2 design fix, and passes after it', async () => {
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'Restyle the card [sim:ui] [sim:critic-fail-once]', { workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 120_000);
    expect(done.status).toBe('COMPLETED');

    const order = t.services.store.listStages(id).map((s) => `${s.stageKey}:${s.status}${s.verdict ? `:${s.verdict}` : ''}`);
    const at = (entry: string) => order.indexOf(entry);
    expect(order).toEqual(expect.arrayContaining(['critique:SUCCESS:FAIL', 'design-fix:SUCCESS', 'critique:SUCCESS:PASS']));
    expect(at('critique:SUCCESS:FAIL')).toBeLessThan(at('design-fix:SUCCESS'));
    expect(at('design-fix:SUCCESS')).toBeLessThan(at('critique:SUCCESS:PASS'));
    // After the design fix the checks run again before the critique looks again.
    expect(order.slice(at('design-fix:SUCCESS'), at('critique:SUCCESS:PASS')).some((e) => e.startsWith('test:'))).toBe(true);

    // The design fix is the designer, pinned to Claude, at Level 2: it can never reach a paid generation tool.
    const [fix] = stagesOf(id, 'design-fix');
    expect(fix).toMatchObject({ role: 'designer', agentId: 'claude', permissionLevel: 2 });
    const fixPrompt = await artifact(id, 'design-prompt.md');
    expect(fixPrompt).toContain('Stage: design-fix');
    expect(fixPrompt).toContain('The dark theme hero loses contrast');
    expect(fixPrompt).toContain('Fix mode inside Full Autopilot');

    // The code review (a fixed team; its primary reviewer's prompt) reads its own previous review, never the critique.
    const firstReview = await artifact(id, 'review-prompt-correctness.md', 'first');
    expect(firstReview).not.toContain('loses contrast');
    expect(firstReview).not.toContain('Both themes hold up');
    expect(firstReview).toContain('Stage: review');

    const report = await artifact(id, 'final-report.md');
    expect(report).toContain('- Visual critique: passed');
    expect(report).not.toContain('The last visual critique did not pass');
  }, 150_000);

  it('reuses a critique PASS while the user-interface files are unchanged', async () => {
    const repo = await addRepo(t, await makeRepo());
    // The implementer changes a component; the review fails once and the fixer changes only sim-output.md.
    const id = await createTask(t, repo, 'Add the badge [sim:ui] [sim:review-fail-once]', { workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 120_000);
    expect(done.status).toBe('COMPLETED');

    const critiques = stagesOf(id, 'critique');
    expect(critiques.map((s) => `${s.status}:${s.verdict}`)).toEqual(['SUCCESS:PASS', 'SUCCESS:PASS']);
    expect(critiques[0]!.agentId).not.toBeNull();
    expect(critiques[1]).toMatchObject({ agentId: null });
    expect(critiques[1]!.summary).toMatch(/^Reused: no user-interface file changed since Visual critique passed at /);
    expect(critiques[1]!.conditionDigest).toBe(critiques[0]!.conditionDigest);
    // One critic run for two passes.
    expect(runsOf(id, 'critique')).toHaveLength(1);
  }, 150_000);

  it('runs the critique once a fix makes the change a user-interface one', async () => {
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'Fix the flow [sim:ui-in-fix] [sim:review-fail-once]', { workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 120_000);
    expect(done.status).toBe('COMPLETED');
    const critiques = stagesOf(id, 'critique').map((s) => `${s.status}:${s.verdict}`);
    expect(critiques).toEqual(['SKIPPED:null', 'SUCCESS:PASS']);
    expect(runsOf(id, 'critique')).toHaveLength(1);
  }, 150_000);

  it('never counts user-interface files that were already changed before the task', async () => {
    const repoPath = await makeRepo({ dirty: { 'Old.tsx': 'export const Old = () => null;\n' } });
    const id = await createTask(t, await addRepo(t, repoPath, IN_PLACE), 'Tidy the API handler', { workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.git.preexistingChanges).toContain('Old.tsx');
    expect(stagesOf(id, 'critique').map((s) => s.status)).toEqual(['SKIPPED']);
  }, 120_000);
});

describe('completion gate: a conditional judge is required exactly when its condition holds', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 8, 27, 12, m)).toISOString();
  const workflow = {
    stages: [
      { key: 'implement', name: 'Implement', role: 'implementer', kind: 'agent', permissionLevel: 2, verdict: false },
      { key: 'critique', name: 'Visual critique', role: 'visual-critic', kind: 'agent', permissionLevel: 1, verdict: true, when: 'ui-changed' },
      { key: 'review', name: 'Review', role: 'reviewer', kind: 'agent', permissionLevel: 1, verdict: true },
    ],
  } as unknown as WorkflowProfile;
  const stage = (stageKey: string, role: string, minute: number, extra: Partial<StageInstance> = {}) =>
    ({ id: `${stageKey}-${minute}`, stageKey, role, kind: 'agent', status: 'SUCCESS', verdict: null, createdAt: at(minute), ...extra }) as StageInstance;
  const gate = (stages: StageInstance[], uiChanged: boolean | null | undefined) =>
    completionGate({ workflow, stages, testRuns: [], activeDirectives: [], taskFiles: [], configuredKinds: new Set(), ...(uiChanged === undefined ? {} : { conditionFacts: { uiChanged } }) });

  const reviewed = [stage('implement', 'implementer', 1), stage('review', 'reviewer', 2, { verdict: 'PASS' })];

  it('does not require the critique when no user-interface file changed', () => {
    expect(gate([...reviewed.slice(0, 1), stage('critique', 'visual-critic', 2, { status: 'SKIPPED' }), stage('review', 'reviewer', 3, { verdict: 'PASS' })], false)).toEqual({ pass: true, failures: [] });
  });

  it('requires it when one did, or when that is unknown', () => {
    for (const facts of [true, null, undefined]) {
      const result = gate(reviewed, facts);
      expect(result.pass).toBe(false);
      expect(result.failures).toEqual([{ code: 'review', message: 'Visual critique has not passed.', remedy: [{ type: 'RETURN_TO_STAGE', params: { stageKey: 'critique' } }] }]);
    }
    // A critique PASS older than the last change does not stand either.
    const stale = gate([stage('implement', 'implementer', 1), stage('critique', 'visual-critic', 2, { verdict: 'PASS' }), stage('implement', 'implementer', 3), stage('review', 'reviewer', 4, { verdict: 'PASS' })], true);
    expect(stale.failures.map((f) => f.message)).toEqual(['Visual critique has not passed since the last change.']);
    expect(gate([...reviewed, stage('critique', 'visual-critic', 3, { verdict: 'PASS' })], true).pass).toBe(true);
  });

  it('keeps requiring a judge without a condition, whatever the facts', () => {
    const result = gate([stage('implement', 'implementer', 1)], false);
    expect(result.failures.map((f) => f.message)).toEqual(['Review has not passed.']);
  });
});

describe('final report: each judge speaks for itself', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 8, 27, 12, m)).toISOString();
  const task = {
    id: 'TASK-0100', title: 'x', description: 'x', mode: 'autopilot', supervised: false, fixCycles: 1, maxFixCycles: 3, recoveryCycle: 0,
    git: { baselineBranch: 'main', baselineCommit: null, taskBranch: null, isolated: false, commits: [] },
    workflow: { name: 'Full Autopilot', stages: [{ key: 'critique', kind: 'agent', role: 'visual-critic', verdict: true, when: 'ui-changed' }, { key: 'review', kind: 'agent', role: 'reviewer', verdict: true }] },
  } as never;
  const repo = { name: 'r', path: '/r' } as never;
  const row = (stageKey: string, role: string, minute: number, status: string, verdict: 'PASS' | 'FAIL' | null, summary: string | null = null) =>
    ({ id: `${stageKey}-${minute}`, stageKey, role, kind: 'agent', status, verdict, createdAt: at(minute), name: stageKey, summary, errorMessage: null }) as never;
  const report = (stages: never[]) => buildFinalReport({ task, repo, stages, testRuns: [], files: [], testsSkipped: false, deployed: 'none' });

  it('drops an earlier critique FAIL once the critique was no longer needed', () => {
    const result = report([row('critique', 'visual-critic', 1, 'SUCCESS', 'FAIL'), row('critique', 'visual-critic', 2, 'SKIPPED', null, 'Skipped: No user-interface files changed in this task'), row('review', 'reviewer', 3, 'SUCCESS', 'PASS')]);
    expect(result.limitations).not.toContain('The last visual critique did not pass.');
    expect(result.markdown).toContain('- Visual critique: not needed — no user-interface files changed in this task');
    expect(result.markdown).toContain('- Review: passed');
  });

  it("names a failed critique even when the code review passed after it", () => {
    const result = report([row('critique', 'visual-critic', 1, 'SUCCESS', 'FAIL'), row('review', 'reviewer', 2, 'SUCCESS', 'PASS')]);
    expect(result.limitations).toContain('The last visual critique did not pass.');
    expect(result.limitations).not.toContain('The last review did not pass.');
  });
});

describe('the cloud cannot make a judge conditional (docs/systems/remote-node.md)', () => {
  const current = {
    stages: [
      { key: 'critique', name: 'Visual critique', role: 'visual-critic', requiresApproval: false, permissionLevel: 1, verdict: true, when: 'ui-changed' },
      { key: 'review', name: 'Review', role: 'reviewer', requiresApproval: false, permissionLevel: 1, verdict: true },
    ],
  };
  const ctx = { settings: {} as never, repository: () => null, workflow: (id: string) => (id === 'copy' ? (current as never) : null) } as GuardContext;
  const save = (stages: unknown[]) => guardRemoteCommand('workflow.save', { id: 'copy' }, { stages }, ctx);

  it('refuses adding or changing a condition, and turning a verdict off', () => {
    const added = save([current.stages[0], { ...current.stages[1], when: 'ui-changed' }]);
    expect(added).toEqual({ ok: false, message: 'Making "Review" run only on a condition can only be done on this machine.' });
    expect(save([...current.stages, { key: 'second', name: 'Second look', role: 'visual-critic', verdict: true, when: 'ui-changed' }]).ok).toBe(false);
    expect(save([current.stages[0], { ...current.stages[1], verdict: false }])).toEqual({ ok: false, message: 'Making "Review" advisory can only be done on this machine.' });
  });

  it('allows keeping or removing one', () => {
    expect(save(current.stages).ok).toBe(true);
    expect(save([{ ...current.stages[0], when: undefined }, current.stages[1]]).ok).toBe(true);
    expect(save([{ ...current.stages[0], when: null }, current.stages[1]]).ok).toBe(true);
  });
});
