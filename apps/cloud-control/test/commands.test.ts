import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addRepo, createTestApp, makeRepo, simAdapters, waitFor, waitForStatus, type TestApp } from '../../orchestrator/test/helpers.js';
import { startCloud, type Cloud } from './harness.js';

/**
 * Durable remote commands, mirrored history, leases and outages, with the
 * real orchestrator as the node and the Worker in the Workers runtime
 * (docs/systems/cloud-control.md §Commands, §Sync).
 */

let cloud: Cloud;
const open: TestApp[] = [];
beforeAll(async () => {
  cloud = await startCloud();
});
afterAll(async () => {
  if (process.env.ACC_CLOUD_LOGS) (await import('node:fs')).writeFileSync(process.env.ACC_CLOUD_LOGS, cloud?.logs.join('') ?? '');
  for (const a of open) await a.close().catch(() => undefined);
  await cloud?.stop();
});

async function repoWithRemote(remote: string): Promise<string> {
  const dir = await makeRepo();
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  return dir;
}

async function node(options: { dataDir?: string; delayMs?: number; repos?: string[] } = {}): Promise<{ t: TestApp; nodeId: string; repoIds: string[] }> {
  const t = await createTestApp({ ...(options.dataDir ? { dataDir: options.dataDir } : {}), adapters: simAdapters(options.delayMs ?? 10) });
  open.push(t);
  const repoIds: string[] = [];
  for (const r of options.repos ?? []) repoIds.push(await addRepo(t, r));
  let nodeId = t.services.remote.status().nodeId;
  if (!nodeId) {
    const code = (await cloud.api('POST', '/api/cloud/pairing-tokens', { label: 'n' })).body.token;
    nodeId = (await t.services.remote.pair({ relayUrl: cloud.url, code, label: `node-${open.length}` })).nodeId!;
  }
  await waitFor(() => t.services.remote.status().state, (s) => s === 'connected', 30_000, 'connected');
  if (repoIds.length) await waitFor(async () => (await cloud.d1(`SELECT COUNT(*) AS n FROM node_repositories WHERE node_id = '${nodeId}'`))[0].n, (n) => n >= repoIds.length, 20_000, 'repository snapshot');
  return { t, nodeId, repoIds };
}

async function close(t: TestApp): Promise<void> {
  await t.close();
  open.splice(open.indexOf(t), 1);
}

const taskBody = (repositoryId: string, description: string, extra: Record<string, unknown> = {}) => ({ description, repositoryId, workflowId: 'normal-development', mode: 'autopilot', ...extra });

describe('commands and history', () => {
  it('creates a task remotely, mirrors it, and keeps the history readable with the node offline', async () => {
    const { t, nodeId, repoIds } = await node({ repos: [await repoWithRemote('https://github.com/example/history.git')] });
    const created = await cloud.api('POST', '/api/tasks', taskBody(repoIds[0]!, 'Created from the cloud'), { 'x-acc-node': nodeId });
    expect(created.status).toBe(201);
    expect(created.headers.get('x-acc-command-status')).toBe('succeeded');
    const taskId = created.body.id as string;
    expect(t.services.store.getTask(taskId)).toBeTruthy();
    await waitForStatus(t, taskId, ['COMPLETED'], 60_000);

    const live = await cloud.api('GET', '/api/tasks?limit=10', undefined, { 'x-acc-node': nodeId });
    expect(live.headers.get('x-acc-source')).toBe('live');
    expect(live.body.items.map((x: { id: string }) => x.id)).toContain(taskId);
    // The mirror catches up: summary, events and a detail snapshot.
    await waitFor(async () => (await cloud.d1(`SELECT status, detail IS NOT NULL AS d FROM cloud_tasks WHERE task_id = '${taskId}'`))[0], (r) => r?.status === 'COMPLETED' && r?.d === 1, 20_000, 'mirrored detail');
    const events = (await cloud.d1(`SELECT COUNT(*) AS n FROM cloud_task_events WHERE task_id = '${taskId}'`))[0].n;
    expect(events).toBeGreaterThan(3);
    const [cmd] = await cloud.d1(`SELECT status, result_status, created_by FROM remote_commands WHERE op = 'task.create'`);
    expect(cmd).toMatchObject({ status: 'succeeded', result_status: 201, created_by: 'operator@example.com' });

    await close(t);
    await waitFor(async () => (await cloud.api('GET', '/api/cloud/nodes')).body.find((n: { id: string }) => n.id === nodeId)?.status, (s) => s === 'offline', 20_000, 'offline');
    const cachedList = await cloud.api('GET', '/api/tasks?limit=10', undefined, { 'x-acc-node': nodeId });
    expect(cachedList.status).toBe(200);
    expect(cachedList.headers.get('x-acc-source')).toBe('cache');
    expect(cachedList.body.items.find((x: { id: string }) => x.id === taskId)).toMatchObject({ status: 'COMPLETED' });
    const cachedDetail = await cloud.api('GET', `/api/tasks/${taskId}`, undefined, { 'x-acc-node': nodeId });
    expect(cachedDetail.body.stages.length).toBeGreaterThan(3);
    expect((await cloud.api('GET', `/api/tasks/${taskId}/events`, undefined, { 'x-acc-node': nodeId })).body.length).toBe(events);
    expect((await cloud.api('GET', '/api/overview', undefined, { 'x-acc-node': nodeId })).body.counts).toBeDefined();
    // Live-only views say so; actions are refused and nothing is stored.
    expect((await cloud.api('GET', '/api/settings', undefined, { 'x-acc-node': nodeId })).body.error.code).toBe('NODE_OFFLINE');
    const before = (await cloud.d1('SELECT COUNT(*) AS n FROM remote_commands'))[0].n;
    const pause = await cloud.api('POST', `/api/tasks/${taskId}/pause`, {}, { 'x-acc-node': nodeId });
    expect(pause).toMatchObject({ status: 503, body: { error: { code: 'NODE_OFFLINE' } } });
    expect((await cloud.d1('SELECT COUNT(*) AS n FROM remote_commands'))[0].n).toBe(before);
  });

  it('runs a command once for a repeated idempotency key', async () => {
    const { t, nodeId, repoIds } = await node({ repos: [await makeRepo()] });
    const draft = await cloud.api('POST', '/api/tasks', taskBody(repoIds[0]!, 'Draft', { start: false }), { 'x-acc-node': nodeId });
    const taskId = draft.body.id as string;
    const headers = { 'x-acc-node': nodeId, 'idempotency-key': 'same-key-0001' };
    const a = await cloud.api('POST', `/api/tasks/${taskId}/directives`, { text: 'Only once, please' }, headers);
    const b = await cloud.api('POST', `/api/tasks/${taskId}/directives`, { text: 'Only once, please' }, headers);
    expect(a.status).toBe(200);
    expect(b.status, JSON.stringify(b.body).slice(0, 400)).toBe(200);
    expect(b.headers.get('x-acc-command-id')).toBe(a.headers.get('x-acc-command-id'));
    expect(t.services.store.listDirectives(taskId).filter((d) => d.text === 'Only once, please')).toHaveLength(1);
    expect((await cloud.d1("SELECT COUNT(*) AS n FROM remote_commands WHERE idempotency_key = 'same-key-0001'"))[0].n).toBe(1);
    // Validation happens in the cloud before anything is stored.
    const invalid = await cloud.api('POST', '/api/tasks', { repositoryId: 'x' }, { 'x-acc-node': nodeId });
    expect(invalid.status).toBe(400);
    const unknown = await cloud.api('POST', '/api/service/shutdown', {}, { 'x-acc-node': nodeId });
    expect(unknown).toMatchObject({ status: 404, body: { error: { code: 'NOT_REMOTE' } } });
  });

  it('queues a task for an offline node when asked, runs it on reconnect, and expires stale commands', async () => {
    const { t, nodeId, repoIds } = await node({ repos: [await makeRepo()] });
    const dataDir = t.dataDir;
    await close(t);
    await waitFor(async () => (await cloud.api('GET', '/api/cloud/nodes')).body.find((n: { id: string }) => n.id === nodeId)?.status, (s) => s === 'offline', 20_000);
    const queued = await cloud.api('POST', '/api/tasks', taskBody(repoIds[0]!, 'Run when the node is back', { start: false }), { 'x-acc-node': nodeId, 'x-acc-queue': '1' });
    expect(queued.status).toBe(202);
    expect(queued.body).toMatchObject({ pending: true, command: { status: 'pending' } });
    const commandId = queued.body.command.id as string;
    // A stale command written while the node was away must never run.
    await cloud.d1(`INSERT INTO remote_commands (id, node_id, op, params, query, body, idempotency_key, payload_hash, status, created_by, created_at, expires_at)
      VALUES ('cmd_stale_000000000001', '${nodeId}', 'agent.refreshAll', '{}', '{}', '{}', 'stale-key-0001', '${'0'.repeat(64)}', 'pending', 'operator@example.com', '2000-01-01T00:00:00.000Z', '2000-01-01T00:02:00.000Z')`);
    const back = await node({ dataDir });
    await waitFor(async () => (await cloud.d1(`SELECT status FROM remote_commands WHERE id = '${commandId}'`))[0].status, (s) => s === 'succeeded', 30_000, 'queued command ran');
    expect(back.t.services.store.listTasks({}).some((x) => x.title.startsWith('Run when the node is back') || x.description === 'Run when the node is back')).toBe(true);
    expect((await cloud.d1("SELECT status FROM remote_commands WHERE id = 'cmd_stale_000000000001'"))[0].status).toBe('expired');
    expect(back.t.services.remote.store.receipt('cmd_stale_000000000001')).toBeNull();
  });

  it('keeps two nodes off the same repository with the cloud lease, and routes Automatic to a node that has it', async () => {
    const remote = 'git@github.com:Example/Shared.git';
    const a = await node({ delayMs: 1_500, repos: [await repoWithRemote(remote)] });
    const b = await node({ repos: [await repoWithRemote('https://github.com/example/shared')] });
    const [fa] = await cloud.d1(`SELECT fingerprint FROM node_repositories WHERE node_id = '${a.nodeId}'`);
    const [fb] = await cloud.d1(`SELECT fingerprint FROM node_repositories WHERE node_id = '${b.nodeId}'`);
    expect(fa.fingerprint).toBe(fb.fingerprint);
    expect(JSON.stringify(await cloud.d1('SELECT * FROM node_repositories'))).not.toMatch(/[A-Za-z]:\\\\/);
    const first = await cloud.api('POST', '/api/tasks', taskBody(a.repoIds[0]!, 'Long work on A'), { 'x-acc-node': a.nodeId });
    expect(first.status).toBe(201);
    const second = await cloud.api('POST', '/api/tasks', taskBody(b.repoIds[0]!, 'Conflicting work on B'), { 'x-acc-node': b.nodeId });
    expect(second).toMatchObject({ status: 409, body: { error: { code: 'LEASE_CONFLICT', details: { heldBy: a.nodeId } } } });
    expect(b.t.services.store.listTasks({})).toHaveLength(0);
    await waitForStatus(a.t, first.body.id, ['COMPLETED'], 90_000);
    await waitFor(async () => (await cloud.d1(`SELECT released_at FROM repository_leases WHERE fingerprint = '${fa.fingerprint}'`))[0]?.released_at, Boolean, 20_000, 'lease released');
    const auto = await cloud.api('POST', '/api/tasks', taskBody(a.repoIds[0]!, 'Anywhere', { start: false }), { 'x-acc-node': 'auto', 'x-acc-source-node': a.nodeId });
    expect(auto.status).toBe(201);
    expect([...a.t.services.store.listTasks({}), ...b.t.services.store.listTasks({})].some((x) => x.id === auto.body.id)).toBe(true);
  });

  it('answers a repeated request once, refuses a reused key, and holds the lease until every task on the repository is done', async () => {
    const remote = 'https://github.com/example/held.git';
    const a = await node({ delayMs: 1_500, repos: [await repoWithRemote(remote)] });
    const b = await node({ repos: [await repoWithRemote(remote)] });
    const [lease] = await cloud.d1(`SELECT fingerprint FROM node_repositories WHERE node_id = '${a.nodeId}'`);
    const key = { 'x-acc-node': a.nodeId, 'idempotency-key': `idem-${Date.now()}` };
    const first = await cloud.api('POST', '/api/tasks', taskBody(a.repoIds[0]!, 'Once only'), key);
    expect(first.status).toBe(201);
    const again = await cloud.api('POST', '/api/tasks', taskBody(a.repoIds[0]!, 'Once only'), key);
    expect(again.status).toBe(201);
    expect(again.headers.get('x-acc-command-id')).toBe(first.headers.get('x-acc-command-id'));
    expect(again.body.id).toBe(first.body.id);
    expect(a.t.services.store.listTasks({}).filter((x) => x.description === 'Once only')).toHaveLength(1);
    const reused = await cloud.api('POST', '/api/tasks', taskBody(a.repoIds[0]!, 'Something else'), key);
    expect(reused).toMatchObject({ status: 422, body: { error: { code: 'IDEMPOTENCY_MISMATCH' } } });

    // A second task on the same repository that ends first must not free the repository while the first still runs.
    const second = await cloud.api('POST', '/api/tasks', taskBody(a.repoIds[0]!, 'Short second task', { start: false }), { 'x-acc-node': a.nodeId });
    expect(second.status).toBe(201);
    expect((await cloud.api('POST', `/api/tasks/${second.body.id}/cancel`, {}, { 'x-acc-node': a.nodeId })).status).toBeLessThan(300);
    await waitFor(async () => (await cloud.d1(`SELECT status FROM cloud_tasks WHERE task_id = '${second.body.id}'`))[0]?.status, (s) => s === 'CANCELLED', 20_000, 'second task mirrored as cancelled');
    expect(a.t.services.store.getTask(first.body.id)!.status).not.toBe('COMPLETED');
    expect((await cloud.d1(`SELECT released_at FROM repository_leases WHERE fingerprint = '${lease.fingerprint}'`))[0].released_at).toBeNull();
    const blocked = await cloud.api('POST', '/api/tasks', taskBody(b.repoIds[0]!, 'Not yet'), { 'x-acc-node': b.nodeId });
    expect(blocked).toMatchObject({ status: 409, body: { error: { code: 'LEASE_CONFLICT' } } });
    expect(b.t.services.store.listTasks({})).toHaveLength(0);
    // When the last task on it ends, the repository is free again.
    await waitForStatus(a.t, first.body.id, ['COMPLETED'], 120_000);
    await waitFor(async () => (await cloud.d1(`SELECT released_at FROM repository_leases WHERE fingerprint = '${lease.fingerprint}'`))[0]?.released_at, Boolean, 30_000, 'lease released after the last task');
  });

  it('survives a control-plane restart: the node reconnects and history is intact', async () => {
    const { t, nodeId } = await node();
    const connections = (await cloud.d1(`SELECT connected_at FROM nodes WHERE id = '${nodeId}'`))[0].connected_at;
    await cloud.restart();
    await waitFor(async () => (await cloud.d1(`SELECT connected_at FROM nodes WHERE id = '${nodeId}'`))[0].connected_at, (c) => c !== connections, 60_000, 'reconnected after restart');
    await waitFor(() => t.services.remote.status().state, (s) => s === 'connected', 30_000);
    const reads = await cloud.api('GET', '/api/agents', undefined, { 'x-acc-node': nodeId });
    expect(reads.status).toBe(200);
    expect(reads.headers.get('x-acc-source')).toBe('live');
  });
});
