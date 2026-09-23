import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import type { UsageEvent, UsageEventPage, UsageOverview, UsageTaskLedger } from '@acc/shared';
import type { UsageDispatch } from '../src/usage/ledger.js';
import { addRepo, createTask, createTestApp, makeRepo, TOKEN, waitFor, waitForStatus, type TestApp } from './helpers.js';

let t: TestApp;

beforeEach(async () => {
  SimulatedAgentAdapter.reset();
  t = await createTestApp();
});

afterEach(async () => {
  await t.close();
});

const DAY = 86_400_000;
const range = () => `from=${new Date(Date.now() - DAY).toISOString()}&to=${new Date(Date.now() + DAY).toISOString()}`;
const stageEvents = (taskId: string) => t.services.usage.queries.taskEvents(taskId).filter((e) => e.origin === 'stage');

async function runTask(description: string, extra: Record<string, unknown> = {}, settle = true) {
  const repoId = await addRepo(t, await makeRepo());
  const id = await createTask(t, repoId, description, { supervised: false, ...extra });
  const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER', 'WAITING_FOR_USAGE_RESET']);
  if (!settle) return { id, repoId, task };
  // The attempt's usage is written as its run finishes; wait until every agent execution has its event.
  await waitFor(
    () => t.services.store.listExecutions(id).filter((e) => e.kind === 'agent' && e.status !== 'running').length,
    (n) => n === stageEvents(id).length,
    5_000,
    'usage events for every agent execution',
  );
  return { id, repoId, task };
}

function dispatch(key: string, patch: Partial<UsageDispatch> = {}): UsageDispatch {
  return {
    key,
    agentId: 'claude',
    provider: 'simulated',
    billing: 'simulated',
    model: 'sim-standard',
    effort: null,
    promptChars: 10,
    promptHash: 'abc',
    startedAt: new Date().toISOString(),
    attribution: { origin: 'source_control', projectId: null, taskId: null, runId: null, workflowId: null, workflowStep: 'commit-message', agentRole: 'committer', mode: null },
    ...patch,
  };
}

const completion = {
  finishedAt: new Date().toISOString(),
  durationMs: 5,
  status: 'succeeded' as const,
  errorClass: null,
  usage: {
    providerRequestId: 'p1',
    resolvedModel: 'sim-standard',
    turns: 1,
    apiDurationMs: null,
    lines: [{ model: 'sim-standard', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: null, reportedCostUsd: 0.001 }],
  },
};

describe('usage capture', () => {
  it('records exactly one event per agent attempt, attributed to project, task, run, stage and role', async () => {
    const { id, repoId, task } = await runTask('Add a greeting');
    expect(task.status).toBe('COMPLETED');
    const events = stageEvents(id);
    const executions = t.services.store.listExecutions(id).filter((e) => e.kind === 'agent');
    expect(events).toHaveLength(executions.length);
    expect(new Set(events.map((e) => e.executionId))).toEqual(new Set(executions.map((e) => e.id)));
    const stages = t.services.store.listStages(id);
    for (const event of events) {
      const stage = stages.find((s) => s.id === event.runId)!;
      expect(stage).toBeTruthy();
      expect(event).toMatchObject({
        projectId: repoId,
        taskId: id,
        workflowId: 'normal-development',
        workflowStep: stage.stageKey,
        agentRole: stage.role,
        agentId: stage.agentId,
        mode: 'autopilot',
        provider: 'simulated',
        billing: 'simulated',
        status: 'succeeded',
        attemptReason: 'initial',
        retryIndex: 0,
      });
      expect(event.tokens.input).toBeGreaterThan(0);
      expect(event.promptHash).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(events.map((e) => e.workflowStep)).toEqual(['investigate', 'plan', 'implement', 'review', 'verify']);
    // The simulated Claude reports a cost like Claude Code; the simulated Codex, like Codex, does not.
    for (const e of events.filter((x) => x.agentId === 'claude')) expect(e).toMatchObject({ costSource: 'PROVIDER', displayCostNanos: expect.any(Number) });
    for (const e of events.filter((x) => x.agentId === 'codex')) expect(e).toMatchObject({ costSource: 'UNKNOWN', displayCostNanos: null });

    const ledger = (await t.api<UsageTaskLedger>('GET', `/api/usage/tasks/${id}`)).body;
    expect(ledger.reconciliation.matches).toBe(true);
    expect(ledger.task.totals.requests).toBe(ledger.events.length);
    expect(ledger.task.totals.unknownCostRequests).toBe(events.filter((e) => e.agentId === 'codex').length);
    expect(ledger.flow.filter((f) => f.runId).map((f) => f.stageKey)).toEqual(['investigate', 'plan', 'implement', 'review', 'verify']);
    expect(ledger.task.totals.costNanos).toBe(events.reduce((s, e) => s + (e.displayCostNanos ?? 0), 0));
    expect(t.services.usage.reconcile().ok).toBe(true);
  });

  it('links re-runs and retries to the attempt before them', async () => {
    const { id } = await runTask('Fix it [sim:review-fail-once]');
    const reviews = stageEvents(id).filter((e) => e.workflowStep === 'review');
    expect(reviews).toHaveLength(2);
    expect(reviews[1]).toMatchObject({ retryIndex: 1, retryParentEventId: reviews[0]!.id, attemptReason: 'rerun' });

    const crash = await runTask('Crash [sim:fail:investigator]');
    const attempts = stageEvents(crash.id).filter((e) => e.workflowStep === 'investigate');
    expect(attempts).toHaveLength(2);
    expect(attempts.map((a) => a.status)).toEqual(['failed', 'failed']);
    expect(attempts[1]).toMatchObject({ attemptReason: 'retry', retryIndex: 1, retryParentEventId: attempts[0]!.id });
    // A crash that reported usage still costs: the failure spend is visible.
    const totals = t.services.usage.queries.totals({ taskId: crash.id });
    expect(totals.failed).toBe(2);
  });

  it('records a reroute to another agent as a fallback with both models', async () => {
    const { id } = await runTask('Crash [sim:fail:investigator]');
    const res = await t.api('POST', `/api/tasks/${id}/reroute`, { stageKey: 'investigate', agentId: 'claude', model: 'sim-standard', effort: 'medium' });
    expect(res.status).toBeLessThan(300);
    await t.api('POST', `/api/tasks/${id}/retry`, { stageKey: 'investigate' });
    await waitFor(() => stageEvents(id).filter((e) => e.workflowStep === 'investigate').length, (n) => n >= 3, 20_000, 'rerouted attempt');
    const third = stageEvents(id).filter((e) => e.workflowStep === 'investigate')[2]!;
    expect(third).toMatchObject({ agentId: 'claude', attemptReason: 'reroute', fallbackFromModel: expect.stringContaining('codex/'), fallbackToModel: 'claude/sim-standard' });
  });

  it('records a usage limit: the attempt with unknown usage, and exhausted capacity', async () => {
    const { id, task } = await runTask('Big job [sim:usage-limit]');
    expect(task.status).toBe('WAITING_FOR_USAGE_RESET');
    const implement = stageEvents(id).find((e) => e.workflowStep === 'implement')!;
    expect(implement).toMatchObject({ status: 'failed', errorClass: 'USAGE_LIMIT', costSource: 'UNKNOWN', displayCostNanos: null });
    expect(implement.tokens.total).toBeNull();
    const providers = (await t.api('GET', `/api/usage/providers?${range()}`)).body as Array<{ provider: string; usageLimitEvents: number; capacity: Array<{ metric: string; status: string; confidence: string }> }>;
    const simulated = providers.find((p) => p.provider === 'simulated')!;
    expect(simulated.usageLimitEvents).toBe(1);
    expect(simulated.capacity).toEqual(expect.arrayContaining([expect.objectContaining({ metric: 'usage_limit', status: 'exhausted', confidence: 'LIVE' })]));
  });

  it('never lets a telemetry failure fail the task or call the provider again, and saves the attempt later', async () => {
    const ledger = t.services.usage.ledger;
    const original = ledger.record.bind(ledger);
    let failures = 0;
    ledger.record = () => {
      failures += 1;
      throw new Error('database is locked');
    };
    const { id } = await (async () => {
      const repoId = await addRepo(t, await makeRepo());
      const taskId = await createTask(t, repoId, 'Keep going', { supervised: false });
      const task = await waitForStatus(t, taskId, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
      expect(task.status).toBe('COMPLETED');
      return { id: taskId };
    })();
    const executions = t.services.store.listExecutions(id).filter((e) => e.kind === 'agent');
    expect(failures).toBeGreaterThanOrEqual(executions.length);
    expect(t.services.usage.recorder.health().pendingWrites).toBe(executions.length);
    expect(t.services.usage.health().checks.find((c) => c.key === 'ingestion')?.state).toBe('degraded');
    expect(existsSync(path.join(t.dataDir, 'usage-spool.jsonl'))).toBe(true);

    ledger.record = original;
    expect(t.services.usage.recorder.flush()).toBe(0);
    expect(stageEvents(id)).toHaveLength(executions.length);
    // Replaying the spool again changes nothing: the execution id is unique.
    expect(t.services.usage.recorder.recover().interrupted).toBe(0);
    expect(stageEvents(id)).toHaveLength(executions.length);
    expect(t.services.store.listExecutions(id).filter((e) => e.kind === 'agent')).toHaveLength(executions.length);
  });

  it('counts an attempt once however often it is written', () => {
    const d = dispatch('exec-dup');
    expect(t.services.usage.ledger.record(d, completion)).not.toBeNull();
    expect(t.services.usage.ledger.record(d, completion)).toBeNull();
    expect(t.services.usage.queries.totals({}).requests).toBe(1);
  });

  it('records an attempt a restart interrupted, with unknown usage', () => {
    t.services.usage.ledger.markPending(dispatch('exec-lost'));
    expect(t.services.usage.recorder.recover().interrupted).toBe(1);
    const page = t.services.usage.queries.events({}, undefined, 10);
    expect(page.items[0]).toMatchObject({ executionId: 'exec-lost', status: 'interrupted', costSource: 'UNKNOWN', displayCostNanos: null });
    expect(t.services.usage.ledger.listPending()).toEqual([]);
  });

  it('keeps the ledger append-only in the database itself', () => {
    const event = t.services.usage.ledger.record(dispatch('exec-immutable'), completion)!;
    const db = t.services.db;
    expect(() => db.prepare('DELETE FROM usage_events').run()).toThrow(/append-only/);
    expect(() => db.prepare('UPDATE usage_events SET input_tokens = 1').run()).toThrow(/immutable/);
    expect(() => db.prepare('UPDATE usage_events SET display_cost_nanos = 1 WHERE id = ?').run(event.id)).toThrow(/unknown cost/);
    expect(() => db.prepare('DELETE FROM usage_event_lines').run()).toThrow(/append-only/);
  });

  it('routes every provider attempt through the metered launch', () => {
    const root = path.resolve(import.meta.dirname, '../src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (file.endsWith('.ts') && !file.endsWith(path.join('services', 'agents.ts')) && /\.execute\(\{/.test(readFileSync(file, 'utf8'))) offenders.push(file);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('pricing and recalculation', () => {
  it('prices Unknown attempts once a verified price exists, keeps an audit trail, and never re-prices history', async () => {
    const { id } = await runTask('Add a greeting');
    const codex = stageEvents(id).filter((e) => e.agentId === 'codex');
    expect(codex.every((e) => e.costSource === 'UNKNOWN')).toBe(true);

    const priceA = await t.api('POST', '/api/usage/pricing', {
      provider: 'simulated',
      providerModelId: 'sim-standard',
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
      effectiveFrom: new Date(Date.now() - DAY).toISOString(),
      source: 'Simulated price list for tests',
      verification: 'verified',
    });
    expect(priceA.status).toBe(201);
    const recalc = (await t.api('POST', '/api/usage/recalculate', { reason: 'test price added' })).body;
    expect(recalc).toMatchObject({ recalculated: codex.length, stillUnknown: 0 });
    const detail = (await t.api('GET', `/api/usage/events/${codex[0]!.id}`)).body;
    expect(detail).toMatchObject({ costSource: 'CALCULATED', pricingVersionId: priceA.body.id });
    expect(detail.revisions).toEqual([expect.objectContaining({ previousSource: 'UNKNOWN', newSource: 'CALCULATED', reason: 'test price added' })]);
    const before = t.services.usage.ledger.get(codex[0]!.id)!;
    // Claude's own reported cost matches the calculated one: reconciliation passes the price check.
    expect(t.services.usage.reconcile().ok).toBe(true);

    // Version B applies from now on; the attempt costed at A keeps A's figure.
    const priceB = await t.api('POST', '/api/usage/pricing', { provider: 'simulated', providerModelId: 'sim-standard', inputPerMillion: 30, outputPerMillion: 150, cacheReadPerMillion: 3, source: 'Tenfold test price', verification: 'verified' });
    expect(priceB.status).toBe(201);
    expect((await t.api('POST', '/api/usage/recalculate', {})).body.recalculated).toBe(0);
    expect(t.services.usage.ledger.get(codex[0]!.id)).toMatchObject({ calculatedCostNanos: before.calculatedCostNanos, pricingVersionId: priceA.body.id });
    const second = await runTask('Another greeting');
    const newer = stageEvents(second.id).find((e) => e.agentId === 'codex')!;
    expect(newer).toMatchObject({ costSource: 'CALCULATED', pricingVersionId: priceB.body.id });
    // A version may not start before the latest one: that would rewrite a costed period.
    const backdated = await t.api('POST', '/api/usage/pricing', { provider: 'simulated', providerModelId: 'sim-standard', inputPerMillion: 1, outputPerMillion: 1, effectiveFrom: new Date(Date.now() - 2 * DAY).toISOString(), source: 'backdated' });
    expect(backdated.status).toBe(400);
  });
});

describe('budgets', () => {
  it('reports warning and exceeded states and refuses duplicates and contradictions', async () => {
    const created = await t.api('POST', '/api/usage/budgets', { scopeType: 'GLOBAL', period: 'month', amountUsd: 0.000001 });
    expect(created.status).toBe(201);
    expect((await t.api('POST', '/api/usage/budgets', { scopeType: 'GLOBAL', period: 'month', amountUsd: 5 })).status).toBe(409);
    expect((await t.api('POST', '/api/usage/budgets', { scopeType: 'GLOBAL', scopeId: 'x', period: 'month', amountUsd: 5 })).status).toBe(400);
    expect((await t.api('POST', '/api/usage/budgets', { scopeType: 'PROVIDER', period: 'month', amountUsd: 5 })).status).toBe(400);
    expect((await t.api('POST', '/api/usage/budgets', { scopeType: 'TASK', scopeId: 'TASK-0001', period: 'month', amountUsd: 5 })).status).toBe(400);
    await runTask('Add a greeting');
    const statuses = (await t.api('GET', '/api/usage/budgets')).body;
    expect(statuses[0]).toMatchObject({ state: 'exceeded', policy: 'WARN_ONLY', unknownCostEvents: expect.any(Number) });
    expect(statuses[0].spentNanos).toBeGreaterThan(0);
    const patched = await t.api('PATCH', `/api/usage/budgets/${created.body.id}`, { amountUsd: 1000 });
    expect(patched.body).toMatchObject({ state: 'ok' });
    expect((await t.api('PATCH', `/api/usage/budgets/${created.body.id}`, { warningThreshold: 0.9, criticalThreshold: 0.5 })).status).toBe(400);
    expect((await t.api('DELETE', `/api/usage/budgets/${created.body.id}`)).status).toBe(204);
  });

  it('stops new agent runs only under an explicit hard-stop policy, and never downgrades the model', async () => {
    const first = await runTask('Add a greeting');
    expect(first.task.status).toBe('COMPLETED');
    const budget = await t.api('POST', '/api/usage/budgets', { scopeType: 'PROVIDER', scopeId: 'simulated', period: 'month', amountUsd: 0.000001, policy: 'STOP_NEW_RUNS' });
    expect(budget.status).toBe(201);
    const { id, task } = await runTask('Second job', {}, false);
    expect(task.status).toBe('WAITING_FOR_USER');
    expect(task.blocker?.message).toContain('Budget exceeded');
    // The refused launch was never a provider attempt: nothing recorded for it.
    expect(stageEvents(id)).toHaveLength(0);

    await t.api('PATCH', `/api/usage/budgets/${budget.body.id}`, { policy: 'WARN_ONLY' });
    await t.api('POST', `/api/tasks/${id}/resume`);
    expect((await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'])).status).toBe('COMPLETED');
  });

  it('fails open when the budget engine itself breaks', async () => {
    await t.api('POST', '/api/usage/budgets', { scopeType: 'GLOBAL', period: 'month', amountUsd: 0.000001, policy: 'STOP_NEW_RUNS' });
    t.services.usage.budgets.blockReason = () => {
      throw new Error('budget table unreadable');
    };
    const { task } = await runTask('Still runs');
    expect(task.status).toBe('COMPLETED');
    expect(t.services.usage.recorder.health().lastError?.message).toContain('Budget check failed');
  });
});

describe('usage API', () => {
  it('requires the token and validates ranges', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/api/usage/overview?${range()}`, headers: { host: '127.0.0.1:4317' } });
    expect(res.statusCode).toBe(401);
    const backwards = await t.api('GET', `/api/usage/overview?from=${new Date().toISOString()}&to=${new Date(Date.now() - DAY).toISOString()}`);
    expect(backwards.status).toBe(400);
    const tooLong = await t.api('GET', `/api/usage/events?from=2020-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z`);
    expect(tooLong.status).toBe(400);
    expect(TOKEN).toBeTruthy();
  });

  it('serves the overview, breakdowns, anomalies, health and a paginated, filtered event list', async () => {
    const { id } = await runTask('Never good enough [sim:review-fail-always]', { maxFixCycles: 3 });
    const overview = (await t.api<UsageOverview>('GET', `/api/usage/overview?${range()}`)).body;
    expect(overview.totals.requests).toBe(stageEvents(id).length);
    expect(overview.simulated).toBe(true);
    expect(overview.billingNote).toContain('Simulated');
    expect(overview.providers.map((p) => p.key)).toEqual(['simulated']);
    expect(overview.health.map((h) => h.key)).toEqual(['ingestion', 'cost', 'aggregates', 'capacity', 'pricing', 'reconciliation']);
    expect(overview.trackingStartedAt).toBeTruthy();
    expect(overview.anomalies.map((a) => a.kind)).toEqual(expect.arrayContaining(['review_fix_loop', 'excessive_retries']));
    const loop = overview.anomalies.find((a) => a.kind === 'review_fix_loop')!;
    expect(loop.explanation).toMatch(/Rule: 3 or more fixer attempts.*Measured: 3 fixer attempts/);

    const models = (await t.api('GET', `/api/usage/breakdown/model?${range()}`)).body;
    expect(models[0]).toMatchObject({ key: 'sim-standard', extra: { provider: 'simulated' } });
    const roles = (await t.api('GET', `/api/usage/breakdown/role?${range()}`)).body as Array<{ key: string; totals: { requests: number } }>;
    expect(roles.find((r) => r.key === 'fixer')?.totals.requests).toBe(3);

    const seen = new Set<string>();
    let cursor: string | null = null;
    let total: number;
    do {
      const page: UsageEventPage = (await t.api<UsageEventPage>('GET', `/api/usage/events?${range()}&limit=3${cursor ? `&cursor=${cursor}` : ''}`)).body;
      total = page.total;
      for (const e of page.items) {
        expect(seen.has(e.id)).toBe(false);
        seen.add(e.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(total);
    const fixers = (await t.api<UsageEventPage>('GET', `/api/usage/events?${range()}&role=fixer`)).body;
    expect(fixers.items.every((e: UsageEvent) => e.agentRole === 'fixer')).toBe(true);
    expect((await t.api<UsageEventPage>('GET', `/api/usage/events?${range()}&q=${id}`)).body.total).toBe(total);

    const tasks = (await t.api('GET', `/api/usage/tasks?${range()}&sort=requests`)).body;
    expect(tasks.items[0]).toMatchObject({ taskId: id, retries: expect.any(Number) });
    const live = (await t.api('GET', `/api/usage/tasks/${id}/live`)).body;
    expect(live.totals.requests).toBe(total);
    const health = (await t.api('GET', '/api/usage/health')).body;
    expect(health.pendingWrites).toBe(0);
    expect((await t.api('POST', '/api/usage/reconcile')).body.ok).toBe(true);
  });

  it('exports filtered CSV and JSON without credentials and with spreadsheet formulas neutralised', async () => {
    const repoId = await addRepo(t, await makeRepo());
    const id = await createTask(t, repoId, 'Formula', { title: '=HYPERLINK("http://x")', supervised: false });
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    await waitFor(() => stageEvents(id).length, (n) => n >= 5, 5_000);
    const csv = await t.app.inject({ method: 'GET', url: `/api/usage/export?${range()}&dataset=events&format=csv`, headers: { host: '127.0.0.1:4317', authorization: `Bearer ${TOKEN}` } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="usage-events-/);
    const [header, ...rows] = csv.body.trim().split('\r\n');
    expect(header).toContain('costSource');
    expect(header).not.toMatch(/prompt|token=|authorization/i);
    expect(rows.length).toBe(stageEvents(id).length);
    expect(csv.body).toContain(`"'=HYPERLINK(""http://x"")"`);
    const json = (await t.api('GET', `/api/usage/export?${range()}&dataset=tasks&format=json`)).body;
    expect(json.rows[0]).toMatchObject({ taskId: id });
    const onlyFixers = await t.app.inject({ method: 'GET', url: `/api/usage/export?${range()}&dataset=events&format=csv&role=fixer`, headers: { host: '127.0.0.1:4317', authorization: `Bearer ${TOKEN}` } });
    expect(onlyFixers.body.trim()).toBe('');
  });
});
