import { afterEach, describe, expect, it } from 'vitest';
import { approvalBindingHash, type NodeFrame } from '@acc/shared';
import { FakeRelay } from './fake-relay.js';
import { addRepo, createTask, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function paired(dataDir?: string): Promise<{ r: FakeRelay; t: TestApp; nodeId: string }> {
  const r = await new FakeRelay().start();
  cleanups.push(() => r.stop());
  const t = await createTestApp(dataDir ? { dataDir } : {});
  cleanups.push(() => t.close());
  const { nodeId } = await t.services.remote.pair({ relayUrl: r.url, code: r.newPairingToken(), label: 'PC' });
  await waitFor(() => t.services.remote.status().state, (s) => s === 'connected', 15_000, 'connected');
  return { r, t, nodeId: nodeId! };
}

function results(r: FakeRelay, id: string): NodeFrame[] {
  return r.results.get(id) ?? [];
}

async function outcome(r: FakeRelay, id: string, count = 1): Promise<NodeFrame> {
  await waitFor(() => results(r, id).length, (n) => n >= count, 20_000, `result for ${id}`);
  return results(r, id).at(-1)!;
}

describe('remote commands', () => {
  it('executes a duplicate delivery once and replays the first result', async () => {
    const { r, t, nodeId } = await paired();
    const repoId = await addRepo(t, await makeRepo());
    const taskId = await createTask(t, repoId, 'Remote directive target', { start: false });
    const command = await r.command(nodeId, 'task.directive', { id: taskId }, { text: 'Keep the public API stable' });
    r.deliver(command);
    const first = await outcome(r, command.id);
    expect(first).toMatchObject({ type: 'command.result', payload: { replayed: false, outcome: { httpStatus: 200 } } });
    r.deliver(command);
    const second = await outcome(r, command.id, 2);
    expect(second).toMatchObject({ type: 'command.result', payload: { replayed: true, outcome: { httpStatus: 200 } } });
    expect(t.services.store.listDirectives(taskId).filter((d) => d.text === 'Keep the public API stable')).toHaveLength(1);
  });

  it('refuses expired, misaddressed, tampered and unknown commands', async () => {
    const { r, nodeId } = await paired();
    const expired = await r.command(nodeId, 'agent.refreshAll', {}, {}, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const misaddressed = await r.command('node_someoneelse0000000', 'agent.refreshAll', {}, {});
    const tampered = { ...(await r.command(nodeId, 'task.cancel', { id: 'TASK-0001' }, {})), params: { id: 'TASK-0002' } };
    const unknown = await r.command(nodeId, 'shell.exec', {}, { command: 'whoami' });
    const readAsCommand = await r.command(nodeId, 'settings.get', {}, undefined);
    for (const c of [expired, misaddressed, tampered, unknown, readAsCommand]) r.deliver(c);
    expect((await outcome(r, expired.id)).payload).toMatchObject({ code: 'REMOTE_COMMAND_EXPIRED', status: 'expired' });
    expect((await outcome(r, misaddressed.id)).payload).toMatchObject({ code: 'REMOTE_FORBIDDEN' });
    expect((await outcome(r, tampered.id)).payload).toMatchObject({ code: 'REMOTE_INVALID', message: expect.stringContaining('payload hash') });
    expect((await outcome(r, unknown.id)).payload).toMatchObject({ code: 'REMOTE_INVALID' });
    expect((await outcome(r, readAsCommand.id)).payload).toMatchObject({ code: 'REMOTE_INVALID' });
  });

  it('never re-runs a command a restart interrupted', async () => {
    const { r, t, nodeId } = await paired();
    const command = await r.command(nodeId, 'agent.refreshAll', {}, {});
    // Simulate a crash mid-run: the receipt exists, the outcome does not.
    t.services.remote.store.recordReceipt(command.id, command.op, command.payloadHash);
    const dataDir = t.dataDir;
    await t.close();
    cleanups.splice(cleanups.length - 1, 1);
    const t2 = await createTestApp({ dataDir });
    cleanups.push(() => t2.close());
    await waitFor(() => t2.services.remote.status().state, (s) => s === 'connected', 15_000);
    r.deliver(command);
    const report = await outcome(r, command.id);
    expect(report.payload).toMatchObject({ code: 'REMOTE_INTERRUPTED', status: 'failed' });
    expect(t2.services.remote.store.receipt(command.id)).toMatchObject({ status: 'interrupted' });
  });

  it('replays a result whose acknowledgement was lost, without running it again', async () => {
    const { r, t, nodeId } = await paired();
    const repoId = await addRepo(t, await makeRepo());
    const taskId = await createTask(t, repoId, 'Lost ack target', { start: false });
    r.ackResults = false;
    const command = await r.command(nodeId, 'task.directive', { id: taskId }, { text: 'Only once' });
    r.deliver(command);
    await outcome(r, command.id);
    expect(t.services.remote.store.unreported().map((x) => x.commandId)).toContain(command.id);
    r.ackResults = true;
    r.pending.set(command.id, command); // the cloud still believes it is pending
    r.dropConnections();
    const replay = await outcome(r, command.id, 2);
    expect(replay.type).toBe('command.result');
    await waitFor(() => t.services.remote.store.unreported().length, (n) => n === 0, 10_000, 'acknowledged');
    expect(t.services.store.listDirectives(taskId).filter((d) => d.text === 'Only once')).toHaveLength(1);
  });

  it('rejects a stale task version', async () => {
    const { r, t, nodeId } = await paired();
    const repoId = await addRepo(t, await makeRepo());
    const taskId = await createTask(t, repoId, 'Draft to edit', { start: false });
    const version = t.services.store.getTask(taskId)!.version;
    const stale = await r.command(nodeId, 'task.update', { id: taskId }, { title: 'Renamed remotely' }, { precondition: { kind: 'taskVersion', taskId, version: version + 5 } });
    r.deliver(stale);
    expect((await outcome(r, stale.id)).payload).toMatchObject({ code: 'REMOTE_CONFLICT' });
    const fresh = await r.command(nodeId, 'task.update', { id: taskId }, { title: 'Renamed remotely' }, { precondition: { kind: 'taskVersion', taskId, version } });
    r.deliver(fresh);
    expect((await outcome(r, fresh.id)).payload).toMatchObject({ outcome: { httpStatus: 200 } });
    expect(t.services.store.getTask(taskId)!.title).toBe('Renamed remotely');
  });

  it('keeps the typed confirmation for a dangerous command and binds the decision to the approval', async () => {
    const { r, t, nodeId } = await paired();
    const repoId = await addRepo(t, await makeRepo({ scripts: { test: 'node -e "0"', build: 'node -e "0" && git reset --hard' } }));
    const taskId = await createTask(t, repoId, 'Dangerous build');
    await waitForStatus(t, taskId, ['WAITING_FOR_USER', 'COMPLETED']);
    const [approval] = (await t.api('GET', '/api/approvals')).body;
    expect(approval).toMatchObject({ risk: 'dangerous', permissionLevel: 5, confirmationPhrase: taskId });
    // The cloud hashes the approval as mirrored (sanitized); the node recomputes it from its own sanitized view.
    const mirrored = r.events.map((e) => e.payload).find((p) => p?.type === 'approval' && p.approval.id === approval.id)?.approval ?? (await waitFor(() => r.events.map((e) => e.payload).find((p) => p?.type === 'approval' && p.approval.id === approval.id)?.approval, Boolean, 10_000, 'mirrored approval'));
    const hash = await approvalBindingHash(mirrored);

    const wrongHash = await r.command(nodeId, 'approval.approve', { id: approval.id }, { confirmation: taskId }, { precondition: { kind: 'approval', approvalId: approval.id, hash: '0'.repeat(64) } });
    r.deliver(wrongHash);
    expect((await outcome(r, wrongHash.id)).payload).toMatchObject({ code: 'REMOTE_CONFLICT' });

    const noPhrase = await r.command(nodeId, 'approval.approve', { id: approval.id }, { confirmation: 'yes' }, { precondition: { kind: 'approval', approvalId: approval.id, hash } });
    r.deliver(noPhrase);
    expect((await outcome(r, noPhrase.id)).payload).toMatchObject({ outcome: { httpStatus: 422 } });
    expect(t.services.store.getApproval(approval.id)!.status).toBe('pending');

    const typed = await r.command(nodeId, 'approval.approve', { id: approval.id }, { confirmation: taskId }, { precondition: { kind: 'approval', approvalId: approval.id, hash } });
    r.deliver(typed);
    expect((await outcome(r, typed.id)).payload).toMatchObject({ outcome: { httpStatus: 200 } });
    expect((await waitForStatus(t, taskId, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'])).status).toBe('COMPLETED');
  });

  it("refuses to loosen this machine's safety settings or open gated features", async () => {
    const { r, t, nodeId } = await paired();
    const level = t.services.settings.get().autoApproveUpToLevel;
    const raise = await r.command(nodeId, 'settings.update', {}, { autoApproveUpToLevel: 5 });
    const billing = await r.command(nodeId, 'settings.update', {}, { billingMode: 'api' });
    const policy = await r.command(nodeId, 'settings.update', {}, { execution: { policyMode: 'full' } });
    const lower = await r.command(nodeId, 'settings.update', {}, { autoApproveUpToLevel: 1 });
    const terminal = await r.command(nodeId, 'terminal.open', {}, { repositoryId: 'x' });
    const toolCall = await r.command(nodeId, 'tool.call', {}, { capability: 'git.status', input: {} });
    for (const c of [raise, billing, policy, lower, terminal, toolCall]) r.deliver(c);
    expect((await outcome(r, raise.id)).payload).toMatchObject({ code: 'REMOTE_FORBIDDEN' });
    expect((await outcome(r, billing.id)).payload).toMatchObject({ code: 'REMOTE_FORBIDDEN' });
    expect((await outcome(r, policy.id)).payload).toMatchObject({ code: 'REMOTE_FORBIDDEN' });
    expect((await outcome(r, lower.id)).payload).toMatchObject({ outcome: { httpStatus: 200 } });
    expect((await outcome(r, terminal.id)).payload).toMatchObject({ code: 'REMOTE_FORBIDDEN', message: expect.stringContaining('Remote terminals are turned off') });
    expect((await outcome(r, toolCall.id)).payload).toMatchObject({ code: 'REMOTE_FORBIDDEN' });
    expect(t.services.settings.get().autoApproveUpToLevel).toBe(Math.min(level, 1));
    expect(t.services.settings.get().billingMode).toBe('subscription');
  });

  it("refuses to choose an agent's program or drop a workflow's approval step remotely", async () => {
    const { r, t, nodeId } = await paired();
    const agentId = t.services.agents.list()[0]!.id;
    const program = await r.command(nodeId, 'agent.update', { id: agentId }, { executablePath: 'C:/Windows/System32/cmd.exe' });
    const toggle = await r.command(nodeId, 'agent.update', { id: agentId }, { loadUserConfig: false });
    const source = t.services.workflows.list().find((w) => w.builtin)!;
    const custom = t.services.workflows.save('guarded-flow', { ...source, id: 'guarded-flow', name: 'Guarded', stages: source.stages.map((st, i) => (i === 0 ? { ...st, requiresApproval: true } : st)) });
    const guarded = custom.stages[0]!;
    const dropped = await r.command(nodeId, 'workflow.save', { id: custom.id }, { ...custom, stages: custom.stages.map((st, i) => (i === 0 ? { ...st, requiresApproval: false } : st)) });
    const renamed = await r.command(nodeId, 'workflow.save', { id: custom.id }, { ...custom, name: 'Guarded (renamed)' });
    for (const c of [program, toggle, dropped, renamed]) r.deliver(c);
    expect((await outcome(r, program.id)).payload).toMatchObject({ code: 'REMOTE_FORBIDDEN' });
    expect((await outcome(r, toggle.id)).payload).toMatchObject({ outcome: { httpStatus: 200 } });
    expect((await outcome(r, dropped.id)).payload).toMatchObject({ code: 'REMOTE_FORBIDDEN', message: expect.stringContaining(guarded.name) });
    expect((await outcome(r, renamed.id)).payload).toMatchObject({ outcome: { httpStatus: 200 } });
    expect(t.services.agents.list().find((a) => a.id === agentId)!.settings.executablePath).toBeNull();
    expect(t.services.workflows.get(custom.id).stages[0]!.requiresApproval).toBe(true);

    // Discovery roots register every repository under them; removed repositories stay removed.
    const root = await makeRepo();
    const addRoot = await r.command(nodeId, 'settings.update', {}, { repositoryAutomation: { roots: [root] } });
    t.services.settings.update({ repositoryAutomation: { ...t.services.settings.get().repositoryAutomation, ignoredPaths: [root] } });
    const unignore = await r.command(nodeId, 'settings.update', {}, { repositoryAutomation: { ignoredPaths: [] } });
    // A section sent in part keeps its other fields: neither the ignore list nor the policy is reset to a default.
    t.services.settings.update({ execution: { ...t.services.settings.get().execution, policyMode: 'safe' } });
    const partial = await r.command(nodeId, 'settings.update', {}, { repositoryAutomation: { intervalMinutes: 30 } });
    const terminalsOnly = await r.command(nodeId, 'settings.update', {}, { execution: { terminals: false } });
    const themeOnly = await r.command(nodeId, 'settings.update', {}, { theme: 'light' });
    for (const c of [addRoot, unignore, partial, terminalsOnly, themeOnly]) r.deliver(c);
    expect((await outcome(r, addRoot.id)).payload).toMatchObject({ code: 'REMOTE_FORBIDDEN' });
    expect((await outcome(r, unignore.id)).payload).toMatchObject({ code: 'REMOTE_FORBIDDEN' });
    for (const c of [partial, terminalsOnly, themeOnly]) expect((await outcome(r, c.id)).payload).toMatchObject({ outcome: { httpStatus: 200 } });
    expect(t.services.settings.get().repositoryAutomation).toMatchObject({ roots: [], ignoredPaths: [root], intervalMinutes: 30 });
    expect(t.services.settings.get().execution).toMatchObject({ policyMode: 'safe', terminals: false });
    expect(t.services.settings.get().theme).toBe('light');

    // Clearing a repository's stricter override falls back to Settings: that is loosening too.
    const repoId = await addRepo(t, await makeRepo());
    t.services.settings.update({ autoApproveUpToLevel: 3, execution: { ...t.services.settings.get().execution, policyMode: 'autopilot' } });
    await t.api('PATCH', `/api/repositories/${repoId}`, { autoApproveUpToLevel: 1, policyMode: 'safe' });
    const clearLevel = await r.command(nodeId, 'repository.update', { id: repoId }, { autoApproveUpToLevel: null });
    const clearPolicy = await r.command(nodeId, 'repository.update', { id: repoId }, { policyMode: null });
    for (const c of [clearLevel, clearPolicy]) r.deliver(c);
    expect((await outcome(r, clearLevel.id)).payload).toMatchObject({ code: 'REMOTE_FORBIDDEN' });
    expect((await outcome(r, clearPolicy.id)).payload).toMatchObject({ code: 'REMOTE_FORBIDDEN' });
    expect(t.services.store.getRepository(repoId)).toMatchObject({ autoApproveUpToLevel: 1, policyMode: 'safe' });
  });

  it('ignores malformed cloud messages and refuses an approval decision not bound to what was seen', async () => {
    const { r, t, nodeId } = await paired();
    for (const bad of [
      { type: 'sync.ack', payload: null },
      { type: 'rpc.request', payload: { requestId: 'x1', op: 'artifact.content', deadline: new Date().toISOString(), params: { id: '../../etc' } } },
      { type: 'subscriptions', payload: { logs: 'nope' } },
      { type: 'terminal.resize', payload: { terminalId: 't', cols: -1, rows: 1e9 } },
      { type: 'no.such.message', payload: {} },
    ]) r.send(bad);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(t.services.remote.status().state).toBe('connected');
    expect((await t.api('GET', '/api/health')).status).toBe(200);
    const approve = await r.command(nodeId, 'approval.approve', { id: 'apr-unbound' }, {});
    r.deliver(approve);
    expect((await outcome(r, approve.id)).payload).toMatchObject({ code: 'REMOTE_INVALID' });
  });

  it('answers typed reads and refuses anything outside the catalog', async () => {
    const { r } = await paired();
    const tasks = await r.rpc('task.list', {}, { limit: '5' });
    expect(tasks).toMatchObject({ httpStatus: 200, body: { items: expect.any(Array) } });
    const health = await r.rpc('service.health');
    expect(health.httpStatus).toBe(200);
    expect(health.body).not.toHaveProperty('dataDir');
    expect(health.body).not.toHaveProperty('port');
    expect((await r.rpc('task.pause', { id: 'TASK-0001' })).httpStatus).toBe(400);
    expect((await r.rpc('service.shutdown')).httpStatus).toBe(400);
    expect((await r.rpc('terminal.output', { id: 'x' })).httpStatus).toBe(403);
  });
});
