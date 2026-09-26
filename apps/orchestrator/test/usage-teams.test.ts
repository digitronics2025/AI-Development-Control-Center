import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import type { Role, StageInstance, UsageEvent, UsageTaskLedger } from '@acc/shared';
import { addRepo, createTask, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from './helpers.js';

/**
 * Stage Teams in the usage read side (docs/systems/usage.md#stage-teams): a
 * team's parallel members are not retries, fix cycles or context baselines of
 * each other, while real re-runs keep raising the same warnings as before.
 */

let t: TestApp;

beforeEach(async () => {
  SimulatedAgentAdapter.reset();
  t = await createTestApp();
});

afterEach(async () => {
  await t.close();
});

const BASE = Date.parse('2026-09-26T08:00:00.000Z');
let seq = 0;

interface Attempt {
  step: string;
  role: Role;
  run: string;
  unit?: string;
  /** Input tokens: the context the rules measure. */
  context: number;
  /** Minutes after BASE. */
  at: number;
}

/** One finished stage attempt through the real ledger, so lineage is linked exactly as in production. */
function record(taskId: string, a: Attempt): UsageEvent {
  seq += 1;
  const startedAt = new Date(BASE + a.at * 60_000).toISOString();
  const event = t.services.usage.ledger.record(
    {
      key: `exec-team-${seq}`,
      agentId: 'claude',
      provider: 'simulated',
      billing: 'simulated',
      model: 'sim-standard',
      effort: null,
      promptChars: 10,
      // Distinct prompts: a team member's prompt carries its own work unit.
      promptHash: `hash-${String(seq).padStart(11, '0')}`,
      startedAt,
      attribution: { origin: 'stage', projectId: null, taskId, runId: a.run, workflowId: 'architecture', workflowStep: a.step, workUnitKey: a.unit ?? null, agentRole: a.role, mode: 'autopilot' },
    },
    {
      finishedAt: new Date(BASE + a.at * 60_000 + 30_000).toISOString(),
      durationMs: 30_000,
      status: 'succeeded',
      errorClass: null,
      usage: {
        providerRequestId: `p-${seq}`,
        resolvedModel: 'sim-standard',
        turns: 1,
        apiDurationMs: null,
        lines: [{ model: 'sim-standard', inputTokens: a.context, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: null, reportedCostUsd: 0.01 }],
      },
    },
  );
  return event!;
}

const anomalies = (taskId: string) => t.services.usage.anomalies.detect({ taskId });

describe('usage anomalies with Stage Teams', () => {
  it('raises nothing for a team task shaped like TASK-0018: decomposed fix, two reviewers failing once', () => {
    const id = 'TASK-TEAM';
    record(id, { step: 'investigate', role: 'investigator', run: 'inv-1', context: 20_000, at: 0 });
    record(id, { step: 'implement', role: 'implementer', run: 'imp-1', unit: 'api', context: 30_000, at: 2 });
    record(id, { step: 'implement', role: 'implementer', run: 'imp-1', unit: 'ui', context: 40_000, at: 2 });
    record(id, { step: 'implement', role: 'implementer', run: 'imp-1', unit: 'integration', context: 45_000, at: 5 });
    // Review round 1 (FAIL): a small risk reviewer beside a large primary.
    record(id, { step: 'review', role: 'reviewer', run: 'rev-1', unit: 'risk', context: 20_000, at: 8 });
    record(id, { step: 'review', role: 'reviewer', run: 'rev-1', unit: 'correctness', context: 60_000, at: 8 });
    // One fix cycle: decomposer, two workers and the integration pass, all logged as fixers.
    record(id, { step: 'fix', role: 'fixer', run: 'fix-1', unit: 'decompose', context: 10_000, at: 10 });
    record(id, { step: 'fix', role: 'fixer', run: 'fix-1', unit: 'fix-a', context: 77_000, at: 12 });
    record(id, { step: 'fix', role: 'fixer', run: 'fix-1', unit: 'fix-b', context: 60_000, at: 12 });
    record(id, { step: 'fix', role: 'fixer', run: 'fix-1', unit: 'integration', context: 70_000, at: 15 });
    // Review round 2 (PASS).
    record(id, { step: 'review', role: 'reviewer', run: 'rev-2', unit: 'risk', context: 22_000, at: 18 });
    record(id, { step: 'review', role: 'reviewer', run: 'rev-2', unit: 'correctness', context: 65_000, at: 18 });

    // The live audit saw four false warnings here: "fix" and "review" ran 4 times, 4 fix cycles, "fix" context grew 7.7×.
    expect(anomalies(id)).toEqual([]);
  });

  it('still flags a single agent that re-runs a stage, loops on fixes and grows its context', () => {
    const id = 'TASK-SOLO';
    const fixes: UsageEvent[] = [];
    for (let round = 1; round <= 4; round++) {
      record(id, { step: 'review', role: 'reviewer', run: `rev-${round}`, context: 20_000, at: round * 10 });
      if (round < 4) fixes.push(record(id, { step: 'fix', role: 'fixer', run: `fix-${round}`, context: round === 2 ? 60_000 : 25_000, at: round * 10 + 5 }));
    }

    const found = anomalies(id);
    expect(found.map((a) => a.kind).sort()).toEqual(['abnormal_token_growth', 'excessive_retries', 'review_fix_loop']);
    const retries = found.find((a) => a.kind === 'excessive_retries')!;
    expect(retries.title).toBe('TASK-SOLO: stage "review" ran 4 times');
    expect(retries.explanation).toMatch(/Measured: 4 attempts costing/);
    const loop = found.find((a) => a.kind === 'review_fix_loop')!;
    expect(loop.title).toBe('TASK-SOLO: 3 fix cycles');
    expect(loop.explanation).toMatch(/Measured: 3 fix cycles costing/);
    const growth = found.find((a) => a.kind === 'abnormal_token_growth')!;
    expect(growth.title).toBe('TASK-SOLO: "fix" context grew 2.4×');
    expect(growth.eventIds).toEqual([fixes[0]!.id, fixes[1]!.id]);
  });

  it('counts a team stage by its runs and each member by its own lineage', () => {
    const id = 'TASK-TEAM-LOOP';
    const correctness: UsageEvent[] = [];
    for (let round = 1; round <= 4; round++) {
      record(id, { step: 'review', role: 'reviewer', run: `rev-${round}`, unit: 'risk', context: 100_000, at: round * 20 });
      correctness.push(record(id, { step: 'review', role: 'reviewer', run: `rev-${round}`, unit: 'correctness', context: round === 4 ? 90_000 : 30_000, at: round * 20 }));
      if (round === 4) break;
      // Each fix cycle decomposes afresh, so its workers' unit keys differ from cycle to cycle.
      record(id, { step: 'fix', role: 'fixer', run: `fix-${round}`, unit: 'decompose', context: 10_000, at: round * 20 + 5 });
      record(id, { step: 'fix', role: 'fixer', run: `fix-${round}`, unit: `c${round}-a`, context: 60_000, at: round * 20 + 7 });
      record(id, { step: 'fix', role: 'fixer', run: `fix-${round}`, unit: `c${round}-b`, context: 60_000, at: round * 20 + 7 });
      record(id, { step: 'fix', role: 'fixer', run: `fix-${round}`, unit: 'integration', context: 40_000, at: round * 20 + 10 });
    }

    const found = anomalies(id);
    expect(found.map((a) => a.kind).sort()).toEqual(['abnormal_token_growth', 'excessive_retries', 'review_fix_loop']);
    const retries = found.find((a) => a.kind === 'excessive_retries')!;
    expect(retries.title).toBe('TASK-TEAM-LOOP: stage "review" ran 4 times');
    expect(retries.explanation).toMatch(/Measured: 4 attempts \(8 agent runs, team members included\)/);
    const loop = found.find((a) => a.kind === 'review_fix_loop')!;
    expect(loop.title).toBe('TASK-TEAM-LOOP: 3 fix cycles');
    expect(loop.explanation).toMatch(/Measured: 3 fix cycles \(12 fixer agent runs, team members included\)/);
    // The primary reviewer's jump is measured against its own previous round, never the larger risk reviewer beside it.
    const growth = found.find((a) => a.kind === 'abnormal_token_growth')!;
    expect(growth.title).toBe('TASK-TEAM-LOOP: "review" (correctness) context grew 3.0×');
    expect(growth.eventIds).toEqual([correctness[2]!.id, correctness[3]!.id]);
  });

  it('counts a stage by its runs or its longest lineage, whichever is more', () => {
    const retries = (taskId: string) => {
      const found = anomalies(taskId);
      expect(found.map((a) => a.kind)).toEqual(['excessive_retries']);
      return found[0]!;
    };

    // One agent, two runs of two attempts each (a parked stage resumes under the same run): 4 attempts, not 2 runs.
    for (const [run, at] of [['imp-1', 0], ['imp-1', 5], ['imp-2', 10], ['imp-2', 15]] as const) {
      record('TASK-SOLO-RESUMED', { step: 'implement', role: 'implementer', run, context: 20_000, at });
    }
    const solo = retries('TASK-SOLO-RESUMED');
    expect(solo.title).toBe('TASK-SOLO-RESUMED: stage "implement" ran 4 times');
    expect(solo.explanation).toMatch(/Measured: 4 attempts costing/);

    // A review team run twice whose primary reviewer is asked once more each time: its lineage (4) outnumbers the runs (2).
    for (let round = 1; round <= 2; round++) {
      record('TASK-TEAM-RERUN', { step: 'review', role: 'reviewer', run: `rev-${round}`, unit: 'risk', context: 20_000, at: round * 20 });
      record('TASK-TEAM-RERUN', { step: 'review', role: 'reviewer', run: `rev-${round}`, unit: 'correctness', context: 20_000, at: round * 20 });
      record('TASK-TEAM-RERUN', { step: 'review', role: 'reviewer', run: `rev-${round}`, unit: 'correctness', context: 20_000, at: round * 20 + 5 });
    }
    const rerun = retries('TASK-TEAM-RERUN');
    expect(rerun.title).toBe('TASK-TEAM-RERUN: stage "review" ran 4 times');
    expect(rerun.explanation).toMatch(/Measured: 4 attempts \(6 agent runs, team members included\)/);

    // An adaptive team re-planned every run, only one unit changing files (so no integration pass): no key repeats, the runs (4) count.
    for (let round = 1; round <= 4; round++) {
      for (const unit of [`p${round}-api`, `p${round}-ui`]) record('TASK-ADAPTIVE', { step: 'implement', role: 'implementer', run: `imp-${round}`, unit, context: 20_000, at: round * 20 });
    }
    const adaptive = retries('TASK-ADAPTIVE');
    expect(adaptive.title).toBe('TASK-ADAPTIVE: stage "implement" ran 4 times');
    expect(adaptive.explanation).toMatch(/Measured: 4 attempts \(8 agent runs, team members included\)/);
  });
});

describe('usage cost flow with Stage Teams', () => {
  it('counts a team run once, with its members and their own attempts listed beside it', async () => {
    const repoId = await addRepo(t, await makeRepo());
    const id = await createTask(t, repoId, 'Add a greeting', { supervised: false });
    expect((await waitForStatus(t, id, ['COMPLETED', 'FAILED'])).status).toBe('COMPLETED');
    const stageEvents = () => t.services.usage.queries.taskEvents(id).filter((e) => e.origin === 'stage');
    await waitFor(
      () => t.services.store.listExecutions(id).filter((e) => e.kind === 'agent' && e.status !== 'running').length,
      (n) => n === stageEvents().length,
      5_000,
      'usage events for every agent execution',
    );

    const stage = (key: string, role: Role, attempt: number): StageInstance => {
      const at = new Date(BASE + attempt * 60_000).toISOString();
      const s: StageInstance = {
        id: `${key}-run-${attempt}`,
        taskId: id,
        stageKey: key,
        name: key === 'fix' ? 'Fix' : 'Review',
        role,
        kind: 'agent',
        status: 'SUCCESS',
        agentId: 'claude',
        model: 'sim-standard',
        effort: null,
        permissionLevel: 1,
        attempt,
        cycle: 0,
        verdict: null,
        summary: null,
        errorClass: null,
        errorMessage: null,
        startedAt: at,
        finishedAt: at,
        createdAt: at,
      };
      t.services.store.insertStage(s);
      return s;
    };
    const fix = stage('fix', 'fixer', 1);
    for (const unit of ['decompose', 'fix-a', 'fix-b', 'integration']) record(id, { step: 'fix', role: 'fixer', run: fix.id, unit, context: 10_000, at: 100 });
    // The primary reviewer was asked once more inside the same run: that is a real second attempt.
    const review = stage('review', 'reviewer', 2);
    record(id, { step: 'review', role: 'reviewer', run: review.id, unit: 'correctness', context: 10_000, at: 110 });
    record(id, { step: 'review', role: 'reviewer', run: review.id, unit: 'risk', context: 10_000, at: 110 });
    record(id, { step: 'review', role: 'reviewer', run: review.id, unit: 'correctness', context: 10_000, at: 112 });

    const ledger = (await t.api<UsageTaskLedger>('GET', `/api/usage/tasks/${id}`)).body;
    expect(ledger.reconciliation.matches).toBe(true);
    // Single-agent stage runs are unchanged: one attempt each, no team.
    for (const row of ledger.flow.filter((f) => f.runId && f.runId !== fix.id && f.runId !== review.id)) {
      expect(row).toMatchObject({ attempts: 1 });
      expect(row.workUnits).toBeUndefined();
    }
    const fixRow = ledger.flow.find((f) => f.runId === fix.id)!;
    expect(fixRow.attempts).toBe(1);
    expect(fixRow.totals.requests).toBe(4);
    expect(fixRow.workUnits?.map((u) => [u.unitKey, u.attempts])).toEqual([
      ['decompose', 1],
      ['fix-a', 1],
      ['fix-b', 1],
      ['integration', 1],
    ]);
    const reviewRow = ledger.flow.find((f) => f.runId === review.id)!;
    expect(reviewRow.attempts).toBe(2);
    expect(reviewRow.totals.requests).toBe(3);
    expect(reviewRow.workUnits?.map((u) => [u.unitKey, u.attempts])).toEqual([
      ['correctness', 2],
      ['risk', 1],
    ]);
  });
});
