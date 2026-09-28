import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '@acc/agent-claude';
import { CodexAdapter } from '@acc/agent-codex';
import type { TaskEvent } from '@acc/shared';
import { RESET_GRACE_MS, type ResetClock } from '../src/usage/reset-scheduler.js';
import { addRepo, createTask, createTestApp, makeRepo, ROOT, waitFor, waitForStatus, type TestApp } from './helpers.js';

/**
 * Auto-resume at a usage reset (AGT-1, docs/systems/usage.md#auto-resume-at-reset)
 * against the real Claude Code and Codex adapters driving the fake CLIs, with
 * a hand-advanced clock: nothing here waits for a real reset.
 */

/** Real time plus an offset; timers run only when `advance` passes them. */
class FakeClock implements ResetClock {
  private offset = 0;
  private seq = 0;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];

  now(): number {
    return Date.now() + this.offset;
  }

  setTimer(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.push({ id, at: this.now() + ms, fn });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  advance(ms: number): void {
    this.offset += ms;
    const due = this.timers.filter((t) => t.at <= this.now()).sort((a, b) => a.at - b.at);
    this.timers = this.timers.filter((t) => !due.includes(t));
    for (const t of due) t.fn();
  }

  /** Move to `ms` before an ISO time. */
  advanceTo(iso: string, ms = 0): void {
    this.advance(Date.parse(iso) - this.now() + ms);
  }
}

// Assembled at runtime so no credential-shaped literal is committed.
const MESSENGER_TOKEN = ['messenger', 'reset', 'bearer', 'q8Lm4'].join('-');
const exe = (name: string) => path.join(ROOT, 'tests', 'fixtures', process.platform === 'win32' ? `${name}.cmd` : name);
const HOUR = 3_600_000;
const epochSeconds = (ms: number) => Math.floor(ms / 1000);
const isoOf = (seconds: number) => new Date(seconds * 1000).toISOString();

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

interface Run {
  app: TestApp;
  clock: FakeClock;
  /** Phone alerts the stand-in messenger received. */
  alerts: Array<Record<string, unknown>>;
  /** What the fake Claude Code does on its next run. */
  next(run: { scenario: 'ok' } | { scenario: 'usage'; resetsAt: number }): void;
}

/** The app with the real adapters on the fake CLIs, phone alerts to a stand-in messenger. */
async function start(dataDir: string, clock = new FakeClock()): Promise<Run> {
  const runFile = path.join(dataDir, 'fake-claude-run.json');
  const alerts: Array<Record<string, unknown>> = [];
  const fetch = (async (_url: URL | string, init: RequestInit = {}) => {
    alerts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response('{}', { status: 201 });
  }) as typeof globalThis.fetch;
  t = await createTestApp({
    dataDir,
    clock,
    adapters: [new CodexAdapter(), new ClaudeCodeAdapter()],
    baseEnv: { ...process.env, FAKE_CLAUDE_APIKEY_SOURCE: 'none', FAKE_CLAUDE_RUN_FILE: runFile },
    alerts: { fetch, retryDelayMs: 20, timeoutMs: 2_000 },
  });
  await t.api('PATCH', '/api/agents/codex', { executablePath: exe('fake-codex') });
  await t.api('PATCH', '/api/agents/claude', { executablePath: exe('fake-claude') });
  await t.services.agents.refresh();
  return { app: t, clock, alerts, next: (run) => writeFileSync(runFile, JSON.stringify(run)) };
}

async function setUpPhone(app: TestApp): Promise<void> {
  await app.services.credentials.create({ name: 'messenger-control-center', kind: 'http', envVar: null, description: 'test', repositoryIds: null, value: MESSENGER_TOKEN });
  const res = await app.api('PATCH', '/api/settings', {
    notifications: { approvals: true, failures: true, completions: false, phone: { url: 'https://messenger.example.com', credentialName: 'messenger-control-center', recipientEmail: 'owner@example.com' } },
  });
  expect(res.status).toBe(200);
}

async function autoResume(app: TestApp, on: boolean): Promise<void> {
  expect((await app.api('PATCH', '/api/settings', { execution: { autoResumeOnReset: on } })).status).toBe(200);
}

/** A task that runs Implement (Claude Code) then the repository's tests, unsupervised. */
async function implementTask(app: TestApp): Promise<string> {
  const copy = (await app.api('POST', '/api/workflows/quick-change/duplicate', {})).body;
  const saved = await app.api('PUT', `/api/workflows/${copy.id}`, {
    ...copy,
    stages: [
      { key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, next: 'test' },
      { key: 'test', name: 'Test', role: 'tester', kind: 'tests', permissionLevel: 2, next: 'complete' },
    ],
  });
  expect(saved.status).toBe(200);
  return createTask(app, await addRepo(app, await makeRepo()), 'Say pong', { workflowId: copy.id, supervised: false });
}

const autoEvents = (app: TestApp, id: string) => app.services.store.eventsOfType(id, ['USAGE_AUTO_RESUME']);
const phases = (app: TestApp, id: string) => autoEvents(app, id).map((e: TaskEvent) => e.data.phase);
const systemResumes = (app: TestApp, id: string) => app.services.chairman.store.listActions(id).filter((a) => a.type === 'RESUME_TASK' && a.initiator === 'system');
const pending = (app: TestApp) => app.services.usage.resets!.pending();

describe('auto-resume at a usage reset', () => {
  it('is off by default; switched on, it resumes a task paused by a rejected rate_limit_event exactly once, after reset + grace, and alerts', async () => {
    const run = await start(mkdtempSync(path.join(os.tmpdir(), 'acc-reset-')));
    const { app, clock } = run;
    await setUpPhone(app);
    const resetsAt = epochSeconds(Date.now() + HOUR);
    run.next({ scenario: 'usage', resetsAt });
    const id = await implementTask(app);
    const waiting = await waitForStatus(app, id, ['WAITING_FOR_USAGE_RESET', 'COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(waiting.status).toBe('WAITING_FOR_USAGE_RESET');
    // Claude's resetsAt is epoch seconds (tests/fixtures/claude-2.1.280-usage.jsonl).
    const reading = app.services.usage.capacity.latest().find((r) => r.agentId === 'claude' && r.metric === 'window:five_hour');
    expect(reading).toMatchObject({ status: 'exhausted', resetAt: isoOf(resetsAt) });
    // Off by default: nothing is planned or said.
    expect(app.services.settings.get().execution.autoResumeOnReset).toBe(false);
    expect(pending(app)).toEqual([]);
    expect(autoEvents(app, id)).toEqual([]);

    await autoResume(app, true);
    const key = `usage-reset:claude:${isoOf(resetsAt)}`;
    const fireAt = new Date(resetsAt * 1000 + RESET_GRACE_MS).toISOString();
    await waitFor(() => pending(app), (p) => p.length === 1, 5_000, 'the armed timer');
    expect(pending(app)).toEqual([{ taskId: id, key, fireAt }]);
    expect(phases(app, id)).toEqual(['scheduled']);
    expect(autoEvents(app, id)[0]!.message).toMatch(/^Resumes by itself at .+, 2 minutes after Claude Code's usage limit resets/);

    // Just before reset + grace nothing happens.
    run.next({ scenario: 'ok' });
    clock.advanceTo(fireAt, -1_000);
    await new Promise((r) => setTimeout(r, 200));
    expect(app.services.store.getTask(id)!.status).toBe('WAITING_FOR_USAGE_RESET');
    expect(systemResumes(app, id)).toEqual([]);

    // At reset + grace: one resume through the gateway, as the system, keyed by the reset.
    clock.advance(2_000);
    await waitFor(() => systemResumes(app, id), (a) => a.length === 1, 30_000, 'the resume');
    const done = await waitForStatus(app, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.status).toBe('COMPLETED');
    expect(systemResumes(app, id)).toEqual([expect.objectContaining({ status: 'completed', source: 'supervisor' })]);
    expect(app.services.chairman.store.actionByKey(id, key)).toMatchObject({ type: 'RESUME_TASK', initiator: 'system' });
    expect(phases(app, id)).toEqual(['scheduled', 'resumed']);
    // The phone hears about it once.
    const sent = await waitFor(
      () => app.services.store.eventsOfType(id, ['ALERT_SENT']).filter((e) => e.data.kind === 'resumed'),
      (e) => e.length === 1,
      10_000,
      'the auto-resume alert',
    );
    expect(sent).toHaveLength(1);
    expect(run.alerts.filter((a) => String(a.title).includes('resumed after the usage reset'))).toHaveLength(1);

    // Exactly once: time goes on, nothing resumes again.
    clock.advance(24 * HOUR);
    await new Promise((r) => setTimeout(r, 200));
    expect(systemResumes(app, id)).toHaveLength(1);
    expect(pending(app)).toEqual([]);
  }, 120_000);

  it('keeps the reset it waits for when a later run of the same agent reports the window open again', async () => {
    const run = await start(mkdtempSync(path.join(os.tmpdir(), 'acc-reset-')));
    const { app, clock } = run;
    await autoResume(app, true);
    const resetsAt = epochSeconds(Date.now() + HOUR);
    run.next({ scenario: 'usage', resetsAt });
    const id = await implementTask(app);
    expect((await waitForStatus(app, id, ['WAITING_FOR_USAGE_RESET', 'COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000)).status).toBe('WAITING_FOR_USAGE_RESET');
    const armed = await waitFor(() => pending(app), (p) => p.length === 1, 5_000, 'the armed timer');

    // Inside the grace, the reading's reset has passed, so admission lets another Claude Code task run. Its run
    // reports the five-hour window open again and becomes the agent's latest reading for that metric.
    run.next({ scenario: 'ok' });
    clock.advanceTo(isoOf(resetsAt), 30_000);
    const other = await implementTask(app);
    expect((await waitForStatus(app, other, ['COMPLETED', 'FAILED', 'WAITING_FOR_USAGE_RESET', 'WAITING_FOR_USER'], 60_000)).status).toBe('COMPLETED');
    expect(app.services.usage.capacity.latest().find((r) => r.agentId === 'claude' && r.metric === 'window:five_hour')).toMatchObject({ status: 'ok' });

    // The waiting task still waits for the reset that blocked it: the timer is unchanged, and no manual note.
    expect(pending(app)).toEqual(armed);
    expect(phases(app, id)).toEqual(['scheduled']);

    clock.advanceTo(armed[0]!.fireAt, 1_000);
    await waitFor(() => systemResumes(app, id), (a) => a.length === 1, 30_000, 'the resume');
    expect((await waitForStatus(app, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000)).status).toBe('COMPLETED');
    expect(phases(app, id)).toEqual(['scheduled', 'resumed']);
    expect(systemResumes(app, other)).toEqual([]);
  }, 180_000);

  it('survives a restart: the timer is re-armed from stored state, fires after it and raises the alert', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'acc-reset-'));
    const first = await start(dataDir);
    await setUpPhone(first.app);
    await autoResume(first.app, true);
    const resetsAt = epochSeconds(Date.now() + 2 * HOUR);
    first.next({ scenario: 'usage', resetsAt });
    const id = await implementTask(first.app);
    expect((await waitForStatus(first.app, id, ['WAITING_FOR_USAGE_RESET', 'COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000)).status).toBe('WAITING_FOR_USAGE_RESET');
    const armed = await waitFor(() => pending(first.app), (p) => p.length === 1, 5_000, 'the armed timer');
    await first.app.close();
    t = null;

    // A new process: nothing of the old timer is left but what the database says.
    const second = await start(dataDir);
    const { app, clock } = second;
    expect(pending(app)).toEqual(armed);
    // Re-armed without announcing it twice.
    expect(phases(app, id)).toEqual(['scheduled']);
    second.next({ scenario: 'ok' });
    clock.advanceTo(armed[0]!.fireAt, 1_000);
    expect((await waitForStatus(app, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000)).status).toBe('COMPLETED');
    expect(systemResumes(app, id)).toHaveLength(1);
    await waitFor(() => app.services.store.eventsOfType(id, ['ALERT_SENT']).filter((e) => e.data.kind === 'resumed'), (e) => e.length === 1, 10_000, 'the auto-resume alert');
  }, 120_000);

  it('waits again on a second limit with a new reset, and never loops on the same reset', async () => {
    const run = await start(mkdtempSync(path.join(os.tmpdir(), 'acc-reset-')));
    const { app, clock } = run;
    await autoResume(app, true);
    const first = epochSeconds(Date.now() + HOUR);
    const second = first + 5 * 3600;
    run.next({ scenario: 'usage', resetsAt: first });
    const id = await implementTask(app);
    await waitForStatus(app, id, ['WAITING_FOR_USAGE_RESET'], 60_000);
    await waitFor(() => pending(app), (p) => p.length === 1, 5_000, 'the first timer');

    // The resumed run hits the limit again, now until a later reset: it waits for that one.
    run.next({ scenario: 'usage', resetsAt: second });
    clock.advanceTo(isoOf(first), RESET_GRACE_MS + 1_000);
    await waitFor(() => systemResumes(app, id), (a) => a.length === 1, 30_000, 'the first resume');
    const rearmed = await waitFor(() => pending(app), (p) => p.length === 1 && p[0]!.key === `usage-reset:claude:${isoOf(second)}`, 60_000, 'the timer for the new reset');
    expect(app.services.store.getTask(id)!.status).toBe('WAITING_FOR_USAGE_RESET');

    // The provider then says the same reset again: one more resume for it, then the task waits for you.
    run.next({ scenario: 'usage', resetsAt: second });
    clock.advanceTo(rearmed[0]!.fireAt, 1_000);
    await waitFor(() => systemResumes(app, id), (a) => a.length === 2, 30_000, 'the second resume');
    await waitFor(() => phases(app, id), (p) => p.at(-1) === 'manual', 60_000, 'the manual wait');
    expect(app.services.store.getTask(id)!.status).toBe('WAITING_FOR_USAGE_RESET');
    expect(pending(app)).toEqual([]);
    expect(autoEvents(app, id).at(-1)!.message).toMatch(/already resumed by itself once/);
    clock.advance(48 * HOUR);
    await new Promise((r) => setTimeout(r, 300));
    expect(systemResumes(app, id)).toHaveLength(2);
    expect(phases(app, id)).toEqual(['scheduled', 'resumed', 'scheduled', 'resumed', 'manual']);
  }, 180_000);

  it('turns a Codex "try again at 21:00" into a reading with a reset time, and waits on it', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'acc-reset-'));
    t = await createTestApp({
      dataDir,
      adapters: [new CodexAdapter(), new ClaudeCodeAdapter()],
      baseEnv: { ...process.env, FAKE_CLAUDE_APIKEY_SOURCE: 'none', FAKE_CODEX_SCENARIO: 'limit' },
    });
    await t.api('PATCH', '/api/agents/codex', { executablePath: exe('fake-codex') });
    await t.api('PATCH', '/api/agents/claude', { executablePath: exe('fake-claude') });
    await t.services.agents.refresh();
    await autoResume(t, true);
    // The default workflow investigates with Codex.
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Investigate', { supervised: false });
    expect((await waitForStatus(t, id, ['WAITING_FOR_USAGE_RESET', 'FAILED', 'WAITING_FOR_USER'], 60_000)).status).toBe('WAITING_FOR_USAGE_RESET');
    const reading = t.services.usage.capacity.latest().find((r) => r.agentId === 'codex' && r.metric === 'usage_limit')!;
    expect(reading.resetAt).not.toBeNull();
    const reset = new Date(reading.resetAt!);
    expect([reset.getHours(), reset.getMinutes()]).toEqual([21, 0]);
    expect(t.services.agents.get('codex').capacityBlock).toMatchObject({ metric: 'usage_limit', resetAt: reading.resetAt });
    const armed = await waitFor(() => pending(t!), (p) => p.length === 1, 5_000, 'the armed timer');
    expect(armed[0]!.key).toBe(`usage-reset:codex:${reading.resetAt}`);

    // A later Codex failure that states no reset (another task's run, once this reading went stale) becomes the
    // latest usage_limit reading. It does not hide the reset this task waits for.
    t.services.usage.capacity.record('openai', 'codex', null, 'Provider error message', [
      { metric: 'usage_limit', label: 'Usage limit', usedPercent: null, status: 'exhausted', resetsAt: null, detail: "You've hit your usage limit.", observedAt: new Date().toISOString() },
    ]);
    expect(t.services.usage.capacity.latest().find((r) => r.agentId === 'codex' && r.metric === 'usage_limit')).toMatchObject({ resetAt: null });
    expect(pending(t)).toEqual(armed);
    expect(phases(t, id)).toEqual(['scheduled']);
  }, 120_000);

  it('leaves a limit with no stated reset time to you', async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'acc-reset-'));
    t = await createTestApp({
      dataDir,
      adapters: [new CodexAdapter(), new ClaudeCodeAdapter()],
      baseEnv: { ...process.env, FAKE_CLAUDE_APIKEY_SOURCE: 'none', FAKE_CODEX_SCENARIO: 'limit', FAKE_CODEX_LIMIT_TEXT: "You've hit your usage limit." },
    });
    await t.api('PATCH', '/api/agents/codex', { executablePath: exe('fake-codex') });
    await t.api('PATCH', '/api/agents/claude', { executablePath: exe('fake-claude') });
    await t.services.agents.refresh();
    await autoResume(t, true);
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Investigate', { supervised: false });
    expect((await waitForStatus(t, id, ['WAITING_FOR_USAGE_RESET', 'FAILED', 'WAITING_FOR_USER'], 60_000)).status).toBe('WAITING_FOR_USAGE_RESET');
    await waitFor(() => phases(t!, id), (p) => p.length === 1, 5_000, 'the manual note');
    expect(phases(t, id)).toEqual(['manual']);
    expect(autoEvents(t, id)[0]!.message).toMatch(/did not say when its usage limit resets/);
    expect(pending(t)).toEqual([]);
  }, 120_000);
});
