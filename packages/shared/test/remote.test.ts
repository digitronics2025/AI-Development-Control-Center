import { describe, expect, it } from 'vitest';
import {
  REMOTE_LIMITS,
  REMOTE_OPERATIONS,
  REMOTE_PROTOCOL_VERSION,
  canTransition,
  canonicalJson,
  commandPayloadHash,
  localPathFor,
  matchRemoteOperation,
  parseNodeFrame,
  remoteOperation,
  sha256Hex,
  validateRemoteBody,
} from '../src/index.js';

const frameBase = { v: REMOTE_PROTOCOL_VERSION, id: 'frame-00000001', at: '2026-09-23T10:00:00.000Z' };

describe('canonical JSON and hashing', () => {
  it('is independent of key order and drops undefined members', async () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'x' }, u: undefined };
    const b = { a: { c: 'x', d: [1, { x: 1, y: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,{"x":1,"y":2}]},"b":1}');
    expect(await sha256Hex(canonicalJson(a))).toBe(await sha256Hex(canonicalJson(b)));
  });

  it('matches the known SHA-256 vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('refuses non-finite numbers', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
  });

  it('binds every field of a command', async () => {
    const base = { nodeId: 'node_aaaaaaaaaaaaaaaa', op: 'task.pause', params: { id: 'TASK-1' }, query: {}, body: {}, precondition: null, expiresAt: '2026-09-23T10:02:00.000Z' };
    const h = await commandPayloadHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await commandPayloadHash({ ...base })).toBe(h);
    expect(await commandPayloadHash({ ...base, params: { id: 'TASK-2' } })).not.toBe(h);
    expect(await commandPayloadHash({ ...base, op: 'task.cancel' })).not.toBe(h);
    expect(await commandPayloadHash({ ...base, expiresAt: '2026-09-23T10:03:00.000Z' })).not.toBe(h);
    expect(await commandPayloadHash({ ...base, precondition: { kind: 'taskVersion', taskId: 'TASK-1', version: 3 } })).not.toBe(h);
  });
});

describe('node frames', () => {
  it('accepts a valid heartbeat', () => {
    const r = parseNodeFrame(JSON.stringify({ ...frameBase, type: 'node.heartbeat', payload: { activeTasks: 1, outboxDepth: 0 } }));
    expect(r.ok).toBe(true);
  });

  it('rejects malformed, unknown, oversize and outdated frames', () => {
    expect(parseNodeFrame('{nope').ok).toBe(false);
    expect(parseNodeFrame(JSON.stringify({ ...frameBase, type: 'shell.exec', payload: { command: 'rm -rf /' } }))).toMatchObject({ ok: false, code: 'REMOTE_INVALID' });
    expect(parseNodeFrame(JSON.stringify({ ...frameBase, type: 'node.heartbeat', payload: { activeTasks: -1, outboxDepth: 0 } })).ok).toBe(false);
    expect(parseNodeFrame(JSON.stringify({ ...frameBase, v: 0, type: 'node.heartbeat', payload: { activeTasks: 0, outboxDepth: 0 } }))).toMatchObject({ ok: false, code: 'NODE_UPDATE_REQUIRED' });
    const huge = JSON.stringify({ ...frameBase, type: 'event.live', payload: { message: 'x'.repeat(REMOTE_LIMITS.frameBytes) } });
    expect(parseNodeFrame(huge)).toMatchObject({ ok: false, code: 'REMOTE_INVALID', message: 'Frame too large' });
  });

  it('bounds event batches', () => {
    const events = Array.from({ length: REMOTE_LIMITS.batchEvents + 1 }, (_, i) => ({ seq: i + 1, kind: 'message', payload: {} }));
    expect(parseNodeFrame(JSON.stringify({ ...frameBase, type: 'event.batch', payload: { events } })).ok).toBe(false);
    expect(parseNodeFrame(JSON.stringify({ ...frameBase, type: 'event.batch', payload: { events: events.slice(0, 5) } })).ok).toBe(true);
    expect(parseNodeFrame(JSON.stringify({ ...frameBase, type: 'event.batch', payload: { events: [] } })).ok).toBe(false);
  });
});

describe('operation catalog', () => {
  it('has unique operation names and route keys', () => {
    const ops = REMOTE_OPERATIONS.map((o) => o.op);
    expect(new Set(ops).size).toBe(ops.length);
    const routes = REMOTE_OPERATIONS.map((o) => `${o.method} ${o.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('contains no generic, shutdown, session, privileged, credential-value or local-path route', () => {
    const routes = REMOTE_OPERATIONS.map((o) => `${o.method} ${o.path}`);
    for (const forbidden of [
      'POST /api/service/shutdown',
      'POST /api/tool-sessions',
      'POST /api/privileged/validate',
      'POST /api/credentials',
      'PATCH /api/credentials/:id',
      'POST /api/mcp',
      'PATCH /api/mcp/:id',
      'POST /api/repositories',
    ]) {
      expect(routes).not.toContain(forbidden);
    }
    expect(routes.some((r) => r.includes('/api/remote'))).toBe(false);
    expect(routes.some((r) => r.includes('/api/tool-session/'))).toBe(false);
    expect(routes.some((r) => r.includes('*'))).toBe(false);
  });

  it('gates terminals and operator tool calls', () => {
    expect(remoteOperation('terminal.open')?.gate).toBe('terminals');
    expect(remoteOperation('terminal.output')?.gate).toBe('terminals');
    expect(remoteOperation('tool.call')?.gate).toBe('tools');
  });

  it('binds approvals and expires them quickly', () => {
    const approve = remoteOperation('approval.approve')!;
    expect(approve.precondition).toBe('approval');
    expect(approve.ttlSeconds).toBeLessThanOrEqual(60);
  });

  it('matches literal segments before parameters and decodes parameters', () => {
    expect(matchRemoteOperation('POST', '/api/agents/refresh')?.operation.op).toBe('agent.refreshAll');
    expect(matchRemoteOperation('GET', '/api/skills')?.operation).toMatchObject({ op: 'skill.list', kind: 'read' });
    expect(matchRemoteOperation('POST', '/api/agents/codex/refresh')).toMatchObject({ operation: { op: 'agent.refresh' }, params: { id: 'codex' } });
    expect(matchRemoteOperation('GET', '/api/tasks/TASK-0001')).toMatchObject({ operation: { op: 'task.get' }, params: { id: 'TASK-0001' } });
    expect(matchRemoteOperation('DELETE', '/api/agents/claude/models/opus%404')?.params).toEqual({ id: 'claude', modelId: 'opus@4' });
  });

  it('refuses unknown routes, wrong methods and traversal in parameters', () => {
    expect(matchRemoteOperation('GET', '/api/service/shutdown')).toBeNull();
    expect(matchRemoteOperation('DELETE', '/api/tasks/TASK-1')).toBeNull();
    expect(matchRemoteOperation('GET', '/api/tasks/..')).toBeNull();
    expect(matchRemoteOperation('GET', '/api/tasks/a%2Fb')).toBeNull();
    expect(matchRemoteOperation('GET', '/api/tasks/a%5Cb')).toBeNull();
    expect(matchRemoteOperation('GET', '/api/tasks/%E0%A4%A')).toBeNull();
  });

  it('builds local paths only from the template', () => {
    const op = remoteOperation('task.get')!;
    expect(localPathFor(op, { id: 'TASK-1' }, {})).toBe('/api/tasks/TASK-1');
    expect(localPathFor(remoteOperation('task.list')!, {}, { status: 'RUNNING', q: 'a b' })).toBe('/api/tasks?status=RUNNING&q=a+b');
    expect(() => localPathFor(op, { id: '../settings' }, {})).toThrow();
    expect(() => localPathFor(op, {}, {})).toThrow();
    expect(() => localPathFor(op, { id: 'TASK-1', extra: 'x' }, {})).toThrow();
  });

  it('validates command bodies with the shared schemas and size limit', () => {
    const create = remoteOperation('task.create')!;
    expect(validateRemoteBody(create, { description: 'x', repositoryId: 'r', workflowId: 'normal-development', mode: 'autopilot' }).ok).toBe(true);
    expect(validateRemoteBody(create, { repositoryId: 'r' }).ok).toBe(false);
    expect(validateRemoteBody(remoteOperation('agent.modelRemove')!, { anything: 1 }).ok).toBe(false);
    expect(validateRemoteBody(remoteOperation('task.directive')!, { text: 'x'.repeat(REMOTE_LIMITS.commandBodyBytes + 10) }).ok).toBe(false);
  });
});

describe('command transitions', () => {
  it('only moves forward and never out of a final state', () => {
    expect(canTransition('pending', 'claimed')).toBe(true);
    expect(canTransition('claimed', 'succeeded')).toBe(true);
    expect(canTransition('succeeded', 'failed')).toBe(false);
    expect(canTransition('claimed', 'expired')).toBe(false);
    expect(canTransition('expired', 'claimed')).toBe(false);
  });
});
