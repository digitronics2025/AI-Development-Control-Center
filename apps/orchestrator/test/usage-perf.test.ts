import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UsageOrigin } from '@acc/shared';
import { createTestApp, type TestApp } from './helpers.js';

/**
 * Plan §7 performance: the dashboard's queries over a realistic ledger —
 * 20,000 attempts across 30 days, 2,000 tasks, 3 providers, 6 models.
 * Budgets are generous (CI machines vary); the measured times are printed
 * so a regression is visible before it fails.
 */
const EVENTS = 20_000;
let t: TestApp;
const timings: Record<string, number> = {};

function time<T>(label: string, fn: () => T): T {
  const start = performance.now();
  const value = fn();
  timings[label] = Math.round(performance.now() - start);
  return value;
}

beforeAll(async () => {
  t = await createTestApp();
  const ledger = t.services.usage.ledger;
  const models = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5.5', 'gpt-6-sol', 'sim-standard'];
  const now = Date.now();
  t.services.db.transaction(() => {
    for (let i = 0; i < EVENTS; i++) {
      const model = models[i % models.length]!;
      const provider = model.startsWith('claude') ? 'anthropic' : model.startsWith('gpt') ? 'openai' : 'simulated';
      const startedAt = new Date(now - (i / EVENTS) * 30 * 86_400_000).toISOString();
      const origin: UsageOrigin = i % 10 === 0 ? 'chairman' : 'source_control';
      ledger.record(
        {
          key: `perf-${i}`,
          agentId: provider === 'openai' ? 'codex' : 'claude',
          provider,
          billing: 'subscription',
          model,
          effort: 'high',
          promptChars: 4000,
          promptHash: `h${i % 3000}`,
          startedAt,
          attribution: { origin, projectId: `repo-${i % 12}`, taskId: `TASK-${String(i % 2000).padStart(4, '0')}`, runId: null, workflowId: 'normal-development', workflowStep: 'x', agentRole: ['planner', 'implementer', 'reviewer', 'fixer'][i % 4]!, mode: 'autopilot' },
        },
        {
          finishedAt: startedAt,
          durationMs: 1000 + (i % 50) * 100,
          status: i % 17 === 0 ? 'failed' : 'succeeded',
          errorClass: null,
          usage: {
            providerRequestId: `r${i}`,
            resolvedModel: model,
            turns: 3,
            apiDurationMs: 900,
            lines: [{ model, inputTokens: 1000 + i, outputTokens: 300, cacheReadTokens: 20_000, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 50, reportedCostUsd: null }],
          },
        },
      );
    }
  })();
}, 180_000);

afterAll(async () => {
  console.log(`[usage perf] ${EVENTS} events: ${JSON.stringify(timings)}`);
  await t.close();
});

const month = () => ({ from: new Date(Date.now() - 31 * 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() });

describe('usage queries at realistic volume', () => {
  it('builds the 30-day overview quickly', () => {
    const overview = time('overview', () => t.services.usage.overview(month()));
    expect(overview.totals.requests).toBe(EVENTS);
    expect(timings.overview).toBeLessThan(5_000);
  });

  it('times the overview parts', () => {
    const f = month();
    const u = t.services.usage;
    time('part:totals', () => u.queries.totals(f));
    time('part:providers', () => u.queries.breakdown(f, 'provider'));
    time('part:models', () => u.queries.breakdown(f, 'model'));
    time('part:trend', () => u.queries.trend(f));
    time('part:taskOutcomes', () => u.queries.taskOutcomes(f));
    time('part:topTasks', () => u.queries.tasks(f, 'cost', 0, 5));
    time('part:health', () => u.healthChecks());
    time('part:budgets', () => u.budgetStatuses());
    expect(true).toBe(true);
  });

  it('pages events and tasks from the server', () => {
    const f = month();
    const first = time('eventsFirstPage', () => t.services.usage.events(f, undefined, 50));
    const second = time('eventsSecondPage', () => t.services.usage.events(f, first.nextCursor!, 50));
    expect(second.items[0]!.startedAt <= first.items.at(-1)!.startedAt).toBe(true);
    const filtered = time('eventsFiltered', () => t.services.usage.events({ ...f, model: 'claude-opus-5', role: 'planner' }, undefined, 50));
    expect(filtered.items.every((e) => e.model === 'claude-opus-5')).toBe(true);
    const tasks = time('taskPage', () => t.services.usage.tasks(f, 'cost', 0, 50));
    expect(tasks.total).toBe(2000);
    expect(timings.eventsFirstPage).toBeLessThan(1_000);
    expect(timings.taskPage).toBeLessThan(3_000);
  });

  it('computes breakdowns, anomalies, reconciliation and exports within bounds', () => {
    const f = month();
    time('modelBreakdown', () => t.services.usage.breakdown(f, 'model'));
    time('anomalies', () => t.services.usage.anomalyList(f));
    const rec = time('reconcile', () => t.services.usage.reconcile());
    expect(rec.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.expected} vs ${c.actual}`)).toEqual([]);
    const csv = time('exportEvents', () => t.services.usage.export(f, 'events', 'csv'));
    expect(csv.body.split('\r\n').length - 2).toBe(EVENTS);
    expect(timings.modelBreakdown).toBeLessThan(3_000);
    expect(timings.reconcile).toBeLessThan(10_000);
    expect(timings.exportEvents).toBeLessThan(15_000);
  });
});
