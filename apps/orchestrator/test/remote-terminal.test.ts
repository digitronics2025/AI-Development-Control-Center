import { afterEach, describe, expect, it } from 'vitest';
import type { NodeFrame } from '@acc/shared';
import { TerminalGrants } from '../src/remote/terminal-grants.js';
import { FakeRelay } from './fake-relay.js';
import { addRepo, createTestApp, makeRepo, waitFor, type TestApp } from './helpers.js';

/**
 * Remote terminals (CLOUD_CONTROL_PLAN §7 "Remote terminal tests";
 * docs/systems/remote-node.md §Terminals): off by default, a local switch,
 * a short-lived grant per terminal, every line classified, and nothing of the
 * transcript mirrored.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function paired(timings: { terminalIdleMs?: number; terminalMaxMs?: number } = {}) {
  const r = await new FakeRelay().start();
  cleanups.push(() => r.stop());
  const t = await createTestApp({ remoteTimings: timings });
  cleanups.push(() => t.close());
  const repoId = await addRepo(t, await makeRepo());
  const { nodeId } = await t.services.remote.pair({ relayUrl: r.url, code: r.newPairingToken(), label: 'PC' });
  await waitFor(() => t.services.remote.status().state, (s) => s === 'connected', 15_000);
  return { r, t, nodeId: nodeId!, repoId };
}

async function openRemote(r: FakeRelay, nodeId: string, repoId: string): Promise<NodeFrame> {
  const cmd = await r.command(nodeId, 'terminal.open', {}, { repositoryId: repoId, cols: 100, rows: 30 });
  r.deliver(cmd);
  await waitFor(() => r.results.get(cmd.id)?.length ?? 0, (n) => n > 0, 30_000, 'terminal.open result');
  return r.results.get(cmd.id)![0]!;
}

const output = (r: FakeRelay, terminalId: string) =>
  r.frames
    .filter((f) => f.type === 'event.live')
    .map((f) => (f.payload as { message: { type: string; terminalId?: string; data?: string } }).message)
    .filter((m) => m.type === 'terminal.output' && m.terminalId === terminalId)
    .map((m) => m.data)
    .join('');

describe('remote terminals', () => {
  it('are unavailable until this machine turns them on', async () => {
    const { r, nodeId, repoId } = await paired();
    const refused = await openRemote(r, nodeId, repoId);
    expect(refused).toMatchObject({ type: 'command.failed', payload: { code: 'REMOTE_FORBIDDEN' } });
  });

  it('run safe lines, refuse dangerous ones, and never mirror the transcript', async () => {
    const { r, t, nodeId, repoId } = await paired();
    await t.api('PATCH', '/api/remote', { remoteTerminals: true });
    const opened = await openRemote(r, nodeId, repoId);
    expect(opened).toMatchObject({ type: 'command.result', payload: { outcome: { httpStatus: 201 } } });
    const terminalId = ((opened.payload as { outcome: { body: { id: string } } }).outcome.body).id;
    r.send({ type: 'subscriptions', payload: { logs: [], terminals: [terminalId] } });
    r.send({ type: 'terminal.input', payload: { terminalId, data: 'echo remote-ok-4242\r' } });
    await waitFor(() => output(r, terminalId), (o) => o.includes('remote-ok-4242'), 30_000, 'safe line output');
    r.send({ type: 'terminal.input', payload: { terminalId, data: 'git reset --hard HEAD\r' } });
    await waitFor(() => output(r, terminalId), (o) => o.includes('Refused from the cloud'), 15_000, 'refusal notice');
    // History recall cannot smuggle a line past the classifier: escape sequences are dropped.
    r.send({ type: 'terminal.input', payload: { terminalId, data: '\x1b[A\r' } });
    // Terminal output is realtime only: nothing of it is in the mirrored events.
    expect(JSON.stringify(r.events)).not.toContain('remote-ok-4242');
    expect(r.events.some((e) => e.payload?.type === 'terminal.output')).toBe(false);
  });

  it('ignores keystrokes for a terminal the cloud did not open', async () => {
    const { r, t } = await paired();
    await t.api('PATCH', '/api/remote', { remoteTerminals: true });
    const repos = (await t.api('GET', '/api/repositories')).body as Array<{ id: string }>;
    const local = (await t.api('POST', '/api/terminals', { repositoryId: repos[0]!.id })).body as { id: string };
    r.send({ type: 'subscriptions', payload: { logs: [], terminals: [local.id] } });
    r.send({ type: 'terminal.input', payload: { terminalId: local.id, data: 'echo sneaky-7777\r' } });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(output(r, local.id)).toBe('');
    const read = (await t.api('GET', `/api/terminals/${local.id}/output`)).body as { output: string };
    expect(read.output).not.toContain('sneaky-7777');
  });

  it('closes when the grant runs out and when the node is revoked', async () => {
    const { r, t, nodeId, repoId } = await paired({ terminalIdleMs: 1_500, terminalMaxMs: 60_000 });
    await t.api('PATCH', '/api/remote', { remoteTerminals: true });
    const first = await openRemote(r, nodeId, repoId);
    const idleId = ((first.payload as { outcome: { body: { id: string } } }).outcome.body).id;
    await waitFor(() => t.services.toolStore.terminal(idleId)?.status, (s) => s === 'exited', 15_000, 'idle terminal closed');

    const second = await openRemote(r, nodeId, repoId);
    const liveId = ((second.payload as { outcome: { body: { id: string } } }).outcome.body).id;
    r.revoke(nodeId);
    await waitFor(() => t.services.toolStore.terminal(liveId)?.status, (s) => s === 'exited', 15_000, 'revoked terminal closed');
  });
});

describe('terminal grant rules', () => {
  const writes: string[] = [];
  const port = { write: (_id: string, d: string) => void writes.push(d), resize: () => undefined, close: async () => undefined };

  it('classifies each line at Enter, supports Backspace and drops Tab and escape sequences', () => {
    writes.length = 0;
    let now = 0;
    const g = new TerminalGrants(port, () => 3, { idleMs: 10_000, maxMs: 60_000 }, () => now);
    expect(g.input('t1', 'echo hi\r').refused).toEqual([]); // not granted: ignored entirely
    expect(writes).toEqual([]);
    g.grant('t1');
    g.input('t1', 'rm -rf /x');
    g.input('t1', '\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f\x7f');
    expect(g.input('t1', 'echo ok\r').refused).toEqual([]);
    expect(g.input('t1', 'git push --force\r').refused).toEqual(['git push --force']);
    expect(writes.join('')).toContain('\x03');
    // The refusal is shown to the viewer, never typed into the shell.
    expect(writes.join('')).not.toContain('Refused');
    expect(g.input('t1', 'ec\tho\x1b[A\r').refused).toEqual([]);
    expect(writes.join('')).not.toContain('\t');
    now = 11_000;
    expect(g.has('t1')).toBe(false);
  });
});
