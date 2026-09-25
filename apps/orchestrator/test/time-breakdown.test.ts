import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { countSuiteRuns, timeBreakdown, timeBreakdownLines, type TimeInput } from '../src/engine/time-breakdown.js';

/**
 * Where a task's time went (docs/plans/LEAD_TIME_PLAN.md §3.3). The fixtures
 * are TASK-0007 and its replay TASK-0008 from the live database: timestamps,
 * stage kinds and event types only (agent commands reduced to generic ones).
 */
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/lead-time-tasks.json', import.meta.url), 'utf8')) as Record<'TASK-0007' | 'TASK-0008', TimeInput>;
const min = (ms: number) => ms / 60_000;

describe('time breakdown of real tasks', () => {
  it('reproduces the replay: no rework, no waiting, a quarter of it re-running the baseline', () => {
    const b = timeBreakdown(fixtures['TASK-0008']);
    const k = b.buckets!;
    expect(min(b.totalMs)).toBeCloseTo(78.6, 0);
    expect(min(k.agentFirstPass)).toBeCloseTo(38.3, 0);
    expect(k.agentRework).toBe(0);
    expect(min(k.checks)).toBeCloseTo(39.3, 0);
    // Only the one-second stop of a restart drain, resumed at once.
    expect(k.parked).toBeLessThan(2_000);
    expect(min(b.baselineMs)).toBeGreaterThan(19.4);
    expect(min(b.baselineMs)).toBeLessThan(19.8);
    // Its wide `vitest run <folders>` and a targeted `npm test -- file` are not full-suite runs.
    expect(b.agentSuiteRuns).toBe(0);
  });

  it('reproduces TASK-0007: rework, checks, the operator waits and four suite runs by agents', () => {
    const b = timeBreakdown(fixtures['TASK-0007']);
    const k = b.buckets!;
    expect(min(b.totalMs)).toBeCloseTo(210.3, 0);
    // Failed agent attempts count in their pass (the investigation's table listed 3.9 min of them apart).
    expect(min(k.agentFirstPass)).toBeCloseTo(44.9, 0);
    expect(min(k.agentRework)).toBeCloseTo(56.8, 0);
    expect(min(k.checks)).toBeCloseTo(47.1, 0);
    expect(min(k.parked)).toBeCloseTo(59.8, 0);
    expect(b.baselineMs).toBe(0);
    expect(b.agentSuiteRuns).toBe(4);
  });

  it('always adds up to the total', () => {
    for (const input of Object.values(fixtures)) {
      const b = timeBreakdown(input);
      expect(Object.values(b.buckets!).reduce((a, x) => a + x, 0)).toBe(b.totalMs);
    }
  });
});

describe('time breakdown rules', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 25, 10, minute)).toISOString();
  const base: TimeInput = { createdAt: at(0), endAt: at(60), finished: true, stages: [], events: [], baselineRuns: [], agentBashLines: [], suiteCommands: [] };

  it('gives each minute to one bucket: stage, then parked, then queued, then overhead', () => {
    const b = timeBreakdown({
      ...base,
      stages: [
        { id: 'a', kind: 'agent', startedAt: at(5), finishedAt: at(20) },
        { id: 't', kind: 'tests', startedAt: at(20), finishedAt: at(30) },
        { id: 'f', kind: 'agent', startedAt: at(40), finishedAt: at(50) },
        { id: 'r', kind: 'release', startedAt: at(52), finishedAt: at(55) },
      ],
      events: [
        { type: 'TASK_STARTED', at: at(5), data: {}, stageId: null },
        { type: 'TEST_FAILED', at: at(30), data: { classification: 'new' }, stageId: 't' },
        { type: 'TASK_WAITING', at: at(30), data: {}, stageId: null },
        { type: 'TASK_RESUMED', at: at(38), data: {}, stageId: null },
      ],
    });
    expect(Object.fromEntries(Object.entries(b.buckets!).map(([k, v]) => [k, min(v)]))).toEqual({ queued: 5, agentFirstPass: 15, agentRework: 10, checks: 10, release: 3, parked: 8, overhead: 9 });
  });

  it('does not count failures that already existed as a reason for rework', () => {
    const b = timeBreakdown({
      ...base,
      stages: [
        { id: 't', kind: 'tests', startedAt: at(0), finishedAt: at(10) },
        { id: 'r', kind: 'agent', startedAt: at(10), finishedAt: at(20) },
      ],
      events: [{ type: 'TEST_FAILED', at: at(5), data: { classification: 'preexisting' }, stageId: 't' }],
    });
    expect(min(b.buckets!.agentFirstPass)).toBe(10);
    expect(b.buckets!.agentRework).toBe(0);
  });

  it('measures a running task up to now, and refuses records it cannot divide', () => {
    const running = timeBreakdown({ ...base, finished: false, stages: [{ id: 'a', kind: 'agent', startedAt: at(10), finishedAt: null }] });
    expect(min(running.buckets!.agentFirstPass)).toBe(50);
    expect(timeBreakdownLines(running)[0]).toBe('- Total: 60.0 min so far');
    const broken = timeBreakdown({ ...base, createdAt: 'not a time' });
    expect(broken.buckets).toBeNull();
    expect(timeBreakdownLines(broken)[0]).toMatch(/^Not enough data/);
  });

  it('counts only full runs of a configured suite as an agent running it', () => {
    const commands = ['npm test', 'npm run test:e2e'];
    expect(countSuiteRuns(['[tool] Bash npm test'], commands)).toBe(1);
    expect(countSuiteRuns(['[tool] Bash cd x && npm run test:e2e 2>&1 | tail -5'], commands)).toBe(1);
    expect(countSuiteRuns(['[tool] Bash npm test > "$TMP/o.log" 2>&1; echo $?'], commands)).toBe(1);
    expect(countSuiteRuns(['[tool] Bash npm test -- a.test.ts', '[tool] Bash npx vitest run a.test.ts', 'npm test', '[tool] Read npm test'], commands)).toBe(0);
    expect(countSuiteRuns(['[tool] Bash npm test'], [])).toBe(0);
  });

  it('writes the report lines with the baseline share and the agents’ own runs', () => {
    const lines = timeBreakdownLines({ totalMs: 60 * 60_000, finished: true, buckets: { queued: 0, agentFirstPass: 20 * 60_000, agentRework: 0, checks: 30 * 60_000, release: 0, parked: 0, overhead: 10 * 60_000 }, baselineMs: 18 * 60_000, agentSuiteRuns: 2 });
    expect(lines).toContain('- Checks: 30.0 min (of which comparing failures with the baseline: 18.0 min)');
    expect(lines).toContain('- Agents ran a configured test suite in full themselves 2 times');
    expect(lines.some((l) => l.startsWith('- Release'))).toBe(false);
  });
});

describe('time breakdown in a finished task', () => {
  it('writes the report section and the task.json field, and serves it for any task', async () => {
    const { addRepo, createTask, createTestApp, makeRepo, waitForStatus } = await import('./helpers.js');
    const app = await createTestApp();
    try {
      const id = await createTask(app, await addRepo(app, await makeRepo()), 'Document it');
      await waitForStatus(app, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
      const artifact = async (name: string) => {
        const rec = app.services.store.listArtifacts(id).filter((a) => a.name === name).at(-1)!;
        return (await app.services.artifacts.read(rec, 2_000_000)).content;
      };
      expect(await artifact('final-report.md')).toMatch(/## Where the time went\n\n- Total: \d+\.\d min\n/);
      const json = JSON.parse(await artifact('task.json')) as { timeBreakdown: { buckets: Record<string, number>; totalMs: number } };
      expect(Object.values(json.timeBreakdown.buckets).reduce((a, x) => a + x, 0)).toBe(json.timeBreakdown.totalMs);
      const res = await app.api('GET', `/api/tasks/${id}/time`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ finished: true, agentSuiteRuns: 0 });
      expect((await app.api('GET', '/api/tasks/TASK-9999/time')).status).toBe(404);
    } finally {
      await app.close();
    }
  }, 90_000);
});
