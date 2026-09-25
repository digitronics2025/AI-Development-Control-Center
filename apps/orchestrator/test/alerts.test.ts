import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EventType } from '@acc/shared';
import { AlertService, alertKindFor } from '../src/services/alerts.js';
import type { ToolScope } from '../src/tools/service.js';
import { addRepo, createTask, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from './helpers.js';

/** Phone alerts through the operator's messenger (docs/plans/LEAD_TIME_PLAN.md §3.4). */

// Assembled at runtime so no credential-shaped literal is committed.
const TOKEN = ['messenger', 'test', 'bearer', 'k7Qp2'].join('-');
const MESSENGER = 'https://messenger.example.com';
const RECIPIENT = 'owner@example.com';

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** A stand-in messenger: answers each call with the next status (the last repeats), or throws for 0. */
function messenger(statuses: number[] = [201]) {
  const calls: Call[] = [];
  const fetch = (async (url: URL | string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
    if (status === 0) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({}), { status });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setUp(statuses?: number[], phone: Record<string, string> = {}) {
  const m = messenger(statuses);
  t = await createTestApp({ alerts: { fetch: m.fetch, retryDelayMs: 20, timeoutMs: 2_000 } });
  await t.services.credentials.create({ name: 'messenger-control-center', kind: 'http', envVar: null, description: 'test', repositoryIds: null, value: TOKEN });
  const res = await t.api('PATCH', '/api/settings', {
    notifications: { approvals: true, failures: true, completions: true, phone: { url: MESSENGER, credentialName: 'messenger-control-center', recipientEmail: RECIPIENT, openUrl: 'https://dash.example.com', ...phone } },
  });
  expect(res.status).toBe(200);
  return m;
}

const alertEvents = (app: TestApp, id: string) => app.services.store.listEvents(id, { limit: 2000 }).filter((e) => e.type === 'ALERT_SENT' || e.type === 'ALERT_NOT_SENT');

/** Put a task into a waiting state the way the engine does: status first, then the event on the bus. */
function enter(app: TestApp, id: string, patch: Parameters<TestApp['services']['store']['updateTask']>[1], type: EventType, message: string) {
  const { store, bus } = app.services;
  store.updateTask(id, patch);
  const event = store.insertEvent({ taskId: id, type, stageId: null, message, data: {}, at: new Date().toISOString() });
  bus.publish({ type: 'event', event });
  return event;
}

function service(app: TestApp, fetch: typeof globalThis.fetch) {
  const { store, bus, settings, credentials } = app.services;
  return new AlertService({ store, bus, settings, credentials, fetch, retryDelayMs: 20, event: (taskId, type, message, data) => void store.insertEvent({ taskId, type, stageId: null, message, data, at: new Date().toISOString() }) });
}

describe('which alert a state calls for', () => {
  it('maps entry events to alert kinds by the state the task is in now', () => {
    const w = (kind: string) => ({ status: 'WAITING_FOR_USER' as const, blocker: { kind, message: 'm' } as never });
    expect(alertKindFor(w('decision'), 'TASK_WAITING')).toBe('decision');
    expect(alertKindFor(w('hard_blocker'), 'TASK_WAITING')).toBe('stopped');
    expect(alertKindFor(w('limit'), 'TASK_WAITING')).toBe('stopped');
    expect(alertKindFor(w('approval'), 'TASK_WAITING')).toBeNull();
    expect(alertKindFor(w('queued'), 'TASK_WAITING')).toBeNull();
    expect(alertKindFor({ status: 'WAITING_FOR_USAGE_RESET', blocker: null }, 'TASK_WAITING')).toBe('usage');
    expect(alertKindFor({ status: 'FAILED', blocker: null }, 'TASK_FAILED')).toBe('failed');
    expect(alertKindFor({ status: 'COMPLETED', blocker: null }, 'TASK_COMPLETED')).toBe('completed');
    // Already moved on: nothing to say.
    expect(alertKindFor({ status: 'RUNNING', blocker: null }, 'TASK_WAITING')).toBeNull();
  });
});

describe('phone alerts', () => {
  it('sends one alert when a real task stops for a decision, as the scoped bot, with a link to the task', async () => {
    const m = await setUp();
    const id = await createTask(t!, await addRepo(t!, await makeRepo()), 'Decide [sim:needs-decision]', { supervised: false });
    await waitForStatus(t!, id, ['WAITING_FOR_USER'], 60_000);
    await waitFor(() => alertEvents(t!, id), (e) => e.length > 0, 10_000, 'an alert event');
    expect(m.calls).toHaveLength(1);
    const [call] = m.calls;
    expect(call!.url).toBe(`${MESSENGER}/api/v1/internal/notifications/ingest`);
    expect(call!.init.redirect).toBe('error');
    expect((call!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(call!.body).toMatchObject({ sourceApp: 'control_center', recipientEmail: RECIPIENT, severity: 'warn', deepLink: `https://dash.example.com/tasks/${id}` });
    expect(call!.body.title).toMatch(new RegExp(`^${id} needs your decision · Decide`));
    expect(String(call!.body.dedupeKey)).toMatch(new RegExp(`^acc:${id}:event:\\d+$`));
    expect(alertEvents(t!, id).map((e) => e.type)).toEqual(['ALERT_SENT']);
  }, 90_000);

  it('never sends twice for one state, even after a restart, and sends late what a restart left unsent', async () => {
    const m = await setUp(undefined, { url: '' });
    const id = await createTask(t!, await addRepo(t!, await makeRepo()), 'Stopped', { start: false });
    // Alerts are off (no messenger address) when the task stops: nothing is sent.
    enter(t!, id, { status: 'WAITING_FOR_USER', blocker: { kind: 'hard_blocker', message: 'The smoke test failed' } }, 'TASK_WAITING', 'Hard blocker');
    await new Promise((r) => setTimeout(r, 50));
    expect(m.calls).toHaveLength(0);
    // Switched on, then "restarted": the state entered within the hour is alerted once.
    await t!.api('PATCH', '/api/settings', { notifications: { ...t!.services.settings.get().notifications, phone: { ...t!.services.settings.get().notifications.phone, url: MESSENGER } } });
    const first = service(t!, m.fetch);
    first.start();
    await waitFor(() => m.calls.length, (n) => n === 1, 5_000, 'the late alert');
    await waitFor(() => alertEvents(t!, id).length, (n) => n === 1, 5_000, 'its event');
    first.stop();
    const second = service(t!, m.fetch);
    second.start();
    // The same event on the bus again changes nothing either.
    t!.services.bus.publish({ type: 'event', event: t!.services.store.lastEventOfType(id, ['TASK_WAITING'])! });
    await new Promise((r) => setTimeout(r, 100));
    second.stop();
    expect(m.calls.length).toBe(1);
    expect(m.calls[0]!.body.title).toMatch(/is stopped/);
  }, 60_000);

  it('follows the per-kind switches, and alerts approvals and completions', async () => {
    const m = await setUp();
    const { store, settings } = t!.services;
    const id = await createTask(t!, await addRepo(t!, await makeRepo()), 'Switches', { start: false });
    settings.update({ notifications: { ...settings.get().notifications, failures: false } });
    enter(t!, id, { status: 'FAILED', blocker: { kind: 'error', message: 'boom' } }, 'TASK_FAILED', 'Failed');
    await new Promise((r) => setTimeout(r, 100));
    expect(m.calls).toHaveLength(0);
    enter(t!, id, { status: 'COMPLETED', blocker: null, finalStatus: 'READY' }, 'TASK_COMPLETED', 'Done');
    await waitFor(() => m.calls.length, (n) => n === 1, 5_000, 'the completion alert');
    expect(m.calls[0]!.body).toMatchObject({ severity: 'info' });
    expect(m.calls[0]!.body.title).toMatch(/is done · ready/);
    const approval = { id: 'appr-1', taskId: id, status: 'pending', action: 'Release to production', reason: 'Level 5', createdAt: new Date().toISOString() };
    t!.services.bus.publish({ type: 'approval', approval } as never);
    await waitFor(() => m.calls.length, (n) => n === 2, 5_000, 'the approval alert');
    expect(m.calls[1]!.body.title).toMatch(/needs your approval/);
    expect(m.calls[1]!.body.body).toMatch(/Release to production: Level 5/);
    expect(store.eventsOfType(id, ['ALERT_SENT']).map((e) => e.data.source)).toEqual([expect.stringMatching(/^event:\d+$/), 'approval:appr-1']);
  }, 60_000);

  it('retries once on a server error, never on a refusal, and never names the address, token or recipient', async () => {
    const m = await setUp([503, 201]);
    const id = await createTask(t!, await addRepo(t!, await makeRepo()), 'Retry', { start: false });
    enter(t!, id, { status: 'WAITING_FOR_USER', blocker: { kind: 'decision', message: 'Which one?' } }, 'TASK_WAITING', 'Decision');
    await waitFor(() => alertEvents(t!, id).length, (n) => n === 1, 5_000, 'an alert event');
    expect(m.calls).toHaveLength(2);
    expect(alertEvents(t!, id)[0]!.type).toBe('ALERT_SENT');

    const refused = messenger([403]);
    const other = await createTask(t!, await addRepo(t!, await makeRepo()), 'Refused', { start: false });
    const s = service(t!, refused.fetch);
    t!.services.alerts.stop();
    s.start();
    enter(t!, other, { status: 'WAITING_FOR_USER', blocker: { kind: 'decision', message: 'Which one?' } }, 'TASK_WAITING', 'Decision');
    await waitFor(() => alertEvents(t!, other).length, (n) => n === 1, 5_000, 'a refusal');
    s.stop();
    expect(refused.calls).toHaveLength(1);
    const [notSent] = alertEvents(t!, other);
    expect(notSent!.type).toBe('ALERT_NOT_SENT');
    expect(notSent!.message).toBe('Phone alert not sent: the messenger answered HTTP 403');
    for (const secret of [TOKEN, MESSENGER, 'messenger.example.com', RECIPIENT]) expect(JSON.stringify(notSent)).not.toContain(secret);

    const down = messenger([0]);
    const third = await createTask(t!, await addRepo(t!, await makeRepo()), 'Down', { start: false });
    const s2 = service(t!, down.fetch);
    s2.start();
    enter(t!, third, { status: 'FAILED', blocker: { kind: 'error', message: 'x' } }, 'TASK_FAILED', 'Failed');
    await waitFor(() => alertEvents(t!, third).length, (n) => n === 1, 5_000, 'a network failure');
    s2.stop();
    // Tried twice (one retry). Starting it also tried the refused alert again: one not sent is retried after a restart.
    expect(down.calls.filter((c) => String(c.body.title).startsWith(`${third} `))).toHaveLength(2);
    expect(alertEvents(t!, third)[0]!.message).toBe('Phone alert not sent: the messenger could not be reached');
  }, 60_000);

  it('redacts and caps what it sends', async () => {
    const m = await setUp();
    const id = await createTask(t!, await addRepo(t!, await makeRepo()), 'Redact', { start: false });
    const leaked = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
    enter(t!, id, { status: 'WAITING_FOR_USER', blocker: { kind: 'hard_blocker', message: `Push refused with ${leaked}. ${'More detail. '.repeat(100)}` } }, 'TASK_WAITING', 'Stopped');
    await waitFor(() => m.calls.length, (n) => n === 1, 5_000, 'the alert');
    const body = String(m.calls[0]!.body.body);
    expect(body).not.toContain(leaked);
    expect(body.length).toBeLessThanOrEqual(600);
    expect(String(m.calls[0]!.body.title).length).toBeLessThanOrEqual(120);
  }, 60_000);

  it('holds a generated token back until MyVault has saved it', async () => {
    const m = await setUp(undefined, { credentialName: 'messenger-generated' });
    await t!.services.credentials.generate({ name: 'messenger-generated', kind: 'http', repositoryIds: [], bytes: 32, taskId: null } as never);
    expect(await t!.api('POST', '/api/alerts/test').then((r) => r.body)).toEqual({ ok: false, reason: 'the credential is missing, or not saved to MyVault yet' });
    expect(m.calls).toHaveLength(0);
  }, 60_000);

  it('sends a test alert from Settings and accepts only https addresses', async () => {
    const m = await setUp();
    expect((await t!.api('POST', '/api/alerts/test')).body).toEqual({ ok: true, status: 201 });
    expect(m.calls[0]!.body).toMatchObject({ sourceApp: 'control_center', title: 'Control Center test alert' });
    const plain = await t!.api('PATCH', '/api/settings', { notifications: { ...t!.services.settings.get().notifications, phone: { ...t!.services.settings.get().notifications.phone, url: 'http://messenger.example.com' } } });
    expect(plain.status).toBeGreaterThanOrEqual(400);
  }, 60_000);
});

describe('the alert token is the orchestrator’s own', () => {
  it('is kept from tool calls, task environments and MCP servers; only a secret deploy may read it', async () => {
    await setUp();
    const { credentials, tools } = t!.services;
    expect(await credentials.value('messenger-control-center', null)).toBeNull();
    expect(await credentials.value('messenger-control-center', null, { reserved: 'orchestrator' })).toBe(TOKEN);
    expect(await credentials.value('messenger-control-center', null, { reserved: 'deploy' })).toBe(TOKEN);
    expect(Object.values(await credentials.envFor(['http', 'other'], null))).not.toContain(TOKEN);
    expect(await credentials.envForMapping({ BEARER: 'messenger-control-center' }, null)).toEqual({});
    const work = mkdtempSync(path.join(os.tmpdir(), 'acc-alerts-'));
    const scope: ToolScope = { taskId: null, stageId: null, sessionId: null, repositoryId: null, cwd: work, roots: [work], stageLevel: 4, autoApproveUpToLevel: 4, mode: 'full', profile: 'operator', escalated: new Set(), protectedPaths: [] } as never;
    const outcome = await tools.invoke({ capability: 'http.request', input: { method: 'POST', url: `${MESSENGER}/api/v1/internal/notifications/ingest`, auth: { credential: 'messenger-control-center' } }, origin: 'agent', scope });
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.summary).toMatch(/No stored credential named "messenger-control-center" is available/);
  }, 60_000);
});

describe('where alerts go is decided on this machine, with an http token only (review of LEAD_TIME_PLAN)', () => {
  it('refuses a cloud settings change to the address, token or recipient, and allows switching alerts off', async () => {
    const { settingsSchema } = await import('@acc/shared');
    const { guardRemoteCommand } = await import('../src/remote/guards.js');
    const { DEFAULT_ROLE_DEFAULTS } = await import('../src/services/settings.js');
    const base = settingsSchema.parse({ roleDefaults: DEFAULT_ROLE_DEFAULTS });
    const on = { ...base, notifications: { ...base.notifications, phone: { url: MESSENGER, credentialName: 'messenger-control-center', recipientEmail: RECIPIENT, openUrl: '' } } };
    const ctx = (settings: typeof base) => ({ settings, repository: () => null, workflow: () => null, agent: () => ({ loadUserConfig: false }) }) as never;
    const phone = (p: Record<string, string>) => ({ notifications: { ...on.notifications, phone: { ...on.notifications.phone, ...p } } });
    expect(guardRemoteCommand('settings.update', {}, phone({ url: 'https://attacker.example' }), ctx(on)).ok).toBe(false);
    expect(guardRemoteCommand('settings.update', {}, phone({ credentialName: 'cloudflare-deploy' }), ctx(on)).ok).toBe(false);
    expect(guardRemoteCommand('settings.update', {}, phone({ recipientEmail: 'someone@example.com' }), ctx(on)).ok).toBe(false);
    expect(guardRemoteCommand('settings.update', {}, { notifications: { ...base.notifications, phone: { url: MESSENGER, credentialName: 'x', recipientEmail: RECIPIENT, openUrl: '' } } }, ctx(base)).ok).toBe(false);
    expect(guardRemoteCommand('settings.update', {}, phone({ url: '', credentialName: '', recipientEmail: '' }), ctx(on)).ok).toBe(true);
    expect(guardRemoteCommand('settings.update', {}, { notifications: { ...on.notifications, completions: false } }, ctx(on)).ok).toBe(true);
  });

  it('never sends a provider key named in Phone alerts, and still gives it to the tasks that use it', async () => {
    const m = await setUp(undefined, { credentialName: 'cloudflare-deploy' });
    const key = ['cf', 'test', 'k3y', 'Zx9'].join('-');
    await t!.services.credentials.create({ name: 'cloudflare-deploy', kind: 'cloudflare', envVar: null, description: 'test', repositoryIds: null, value: key });
    expect((await t!.api('POST', '/api/alerts/test')).body).toEqual({ ok: false, reason: 'the credential is missing, or not saved to MyVault yet' });
    expect(m.calls).toHaveLength(0);
    expect((await t!.services.credentials.envFor(['cloudflare'], null)).CLOUDFLARE_API_TOKEN).toBe(key);
  }, 60_000);

  it('lets no staging secret put read the token; only a production put, which always asks the operator', async () => {
    await setUp();
    const work = mkdtempSync(path.join(os.tmpdir(), 'acc-alerts-'));
    const scope: ToolScope = { taskId: null, stageId: null, sessionId: null, repositoryId: null, cwd: work, roots: [work], stageLevel: 4, autoApproveUpToLevel: 4, mode: 'full', profile: 'operator', escalated: new Set(), protectedPaths: [] } as never;
    const staging = await t!.services.tools.invoke({ capability: 'cloudflare.secret_put', input: { credential: 'messenger-control-center', secretName: 'ECHO', environment: 'staging' }, origin: 'agent', scope });
    expect(staging.result.ok).toBe(false);
    expect(staging.result.summary).toMatch(/No credential named "messenger-control-center" is available/);
    const production = await t!.services.tools.invoke({ capability: 'cloudflare.secret_put', input: { credential: 'messenger-control-center', secretName: 'ECHO', environment: 'production' }, origin: 'agent', scope });
    // Level 5: never runs on an agent's word (refused above the stage ceiling, or held for the typed approval).
    expect(['deny', 'approval']).toContain(production.decision);
    expect(production.result.ok).toBe(false);
  }, 60_000);
});
