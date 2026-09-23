import { describe, expect, it } from 'vitest';
import type { CloudNodeView } from '@acc/shared';
import { authHeaders } from '../api/client';
import { detectMode, NodeSelection, pickNode } from './mode';

const doc = (token: string | null) => ({ querySelector: () => (token === null ? null : ({ content: token } as HTMLMetaElement)) }) as unknown as Pick<Document, 'querySelector'>;

function node(id: string, status: CloudNodeView['status']): CloudNodeView {
  return { id, label: id, status, os: null, appVersion: null, protocolVersion: 1, updateRequired: false, capabilities: null, repositories: [], keyVersion: 1, createdAt: '', lastSeenAt: null, connectedAt: null, revokedAt: status === 'revoked' ? 'x' : null };
}

describe('mode detection', () => {
  it('is local when the orchestrator injected its token, cloud otherwise', () => {
    expect(detectMode(doc('abc'))).toEqual({ mode: 'local', token: 'abc' });
    expect(detectMode(doc(''))).toEqual({ mode: 'cloud' });
    expect(detectMode(doc(null))).toEqual({ mode: 'cloud' });
  });
});

describe('request authentication', () => {
  it('sends the bearer token locally and never in the cloud', () => {
    expect(authHeaders({ kind: 'local', token: 't0k' }, 'POST')).toEqual({ authorization: 'Bearer t0k' });
    const cloudGet = authHeaders({ kind: 'cloud', node: () => 'node_abc' }, 'GET');
    expect(cloudGet).toEqual({ 'x-acc-node': 'node_abc' });
    const cloudPost = authHeaders({ kind: 'cloud', node: () => 'node_abc' }, 'POST');
    expect(cloudPost.authorization).toBeUndefined();
    expect(cloudPost['idempotency-key']).toMatch(/^[0-9a-f]{32}$/);
    expect(authHeaders({ kind: 'cloud', node: () => 'node_abc' }, 'POST')['idempotency-key']).not.toBe(cloudPost['idempotency-key']);
    expect(authHeaders({ kind: 'cloud', node: () => null }, 'GET')).toEqual({});
  });
});

describe('node choice', () => {
  it('keeps a usable stored choice, else prefers an online node, never a revoked one', () => {
    const nodes = [node('a', 'offline'), node('b', 'online'), node('c', 'revoked')];
    expect(pickNode(nodes, 'a')).toBe('a');
    expect(pickNode(nodes, 'c')).toBe('b');
    expect(pickNode(nodes, null)).toBe('b');
    expect(pickNode([node('a', 'offline')], null)).toBe('a');
    expect(pickNode([node('c', 'revoked')], 'c')).toBeNull();
  });

  it('remembers the selection and notifies subscribers', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const s = new NodeSelection(storage);
    let calls = 0;
    s.subscribe(() => calls++);
    s.select('node_x');
    s.select('node_x');
    expect(calls).toBe(1);
    expect(new NodeSelection(storage).get()).toBe('node_x');
  });
});

describe('cloud responses', () => {
  it('treats only an unfinished command as pending, not a route that answers 202 itself', async () => {
    const { createApi } = await import('../api/client');
    const respond = (status: number, headers: Record<string, string>) => (globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status, headers })) as typeof fetch);
    const api = createApi({ baseUrl: 'http://cloud', auth: { kind: 'cloud', node: () => 'node_abc' } });
    respond(202, { 'x-acc-command-id': 'cmd_1', 'x-acc-command-status': 'succeeded' });
    await expect(api.post('/api/tasks/T/chairman/messages', { text: 'hi' })).resolves.toEqual({ ok: true });
    respond(202, { 'x-acc-command-id': 'cmd_2', 'x-acc-command-status': 'claimed' });
    await expect(api.post('/api/tasks', {})).rejects.toMatchObject({ code: 'REMOTE_PENDING' });
  });
});
