import { createHash, webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { frame, sessionProofMessage, REMOTE_PROTOCOL_VERSION } from '@acc/shared';
import { httpJson, startCloud, type Cloud } from './harness.js';

/**
 * Storage and the hub at the protocol level, with a hand-driven node:
 * D1 idempotency for event batches, R2 uploads verified by SHA-256 and
 * served only through the authenticated control host, and browser fan-out
 * (docs/systems/cloud-control.md §Data, §Hub).
 */

let cloud: Cloud;
beforeAll(async () => {
  cloud = await startCloud();
});
afterAll(async () => {
  await cloud?.stop();
});

function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
  return httpJson(cloud.url, 'POST', pathname, body, headers);
}

/** A minimal node: pairs, opens a session and a socket, and speaks raw frames. */
async function manualNode() {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const sign = async (m: string) => Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(m))).toString('base64url');
  const token = (await cloud.api('POST', '/api/cloud/pairing-tokens', { label: 'manual' })).body.token;
  const { body } = await post('/node/v1/pair', { token, publicKey: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, label: 'Manual node', os: 'test', appVersion: 'test', protocolVersion: REMOTE_PROTOCOL_VERSION });
  const nodeId = body.nodeId as string;
  const session = async () => {
    const c = await post('/node/v1/challenge', { nodeId });
    return (await post('/node/v1/session', { nodeId, nonce: c.body.nonce, signature: await sign(sessionProofMessage('session', nodeId, c.body.nonce)), protocolVersion: REMOTE_PROTOCOL_VERSION })).body.session as string;
  };
  const connect = async () => {
    const received: any[] = [];
    const ws = new WebSocket(`${cloud.url.replace('http', 'ws')}/node/v1/connect`, { headers: { authorization: `Bearer ${await session()}` } });
    ws.on('message', (d) => received.push(JSON.parse(d.toString())));
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const send = (type: string, payload: unknown) => ws.send(JSON.stringify(frame({ type, payload })));
    const next = async (type: string, timeoutMs = 10_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const i = received.findIndex((m) => m.type === type);
        if (i !== -1) return received.splice(i, 1)[0];
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`no ${type} frame`);
    };
    send('node.hello', { label: 'Manual node', os: 'test', appVersion: 'test', protocolVersion: REMOTE_PROTOCOL_VERSION, lastIssuedSeq: 0 });
    const welcome = await next('session.welcome');
    return { ws, send, next, welcome };
  };
  return { nodeId, session, connect };
}

describe('event batches', () => {
  it('stores a batch once, however often it is sent, and moves the cursor', async () => {
    const node = await manualNode();
    const conn = await node.connect();
    expect(conn.welcome.payload.ackedSeq).toBe(0);
    const task = { id: 'TASK-0042', title: 'Mirrored', status: 'RUNNING', version: 3, repositoryId: 'r1', repositoryName: 'repo', createdAt: '2026-09-23T10:00:00.000Z', updatedAt: '2026-09-23T10:00:01.000Z' };
    const events = [
      { seq: 1, kind: 'message', payload: { type: 'task', task } },
      { seq: 2, kind: 'message', payload: { type: 'event', event: { id: 7, taskId: 'TASK-0042', type: 'STAGE_STARTED', stageId: null, message: 'Investigate started', data: {}, at: '2026-09-23T10:00:02.000Z' } } },
      { seq: 3, kind: 'message', payload: { type: 'usage', event: { id: 'u1', taskId: 'TASK-0042', provider: 'anthropic', model: 'default', startedAt: '2026-09-23T10:00:03.000Z', displayCostNanos: 1200 } } },
    ];
    conn.send('event.batch', { events });
    expect((await conn.next('sync.ack')).payload.upToSeq).toBe(3);
    conn.send('event.batch', { events });
    expect((await conn.next('sync.ack')).payload.upToSeq).toBe(3);
    // A later batch that overlaps an earlier one only adds what is new.
    conn.send('event.batch', { events: [events[1], { seq: 4, kind: 'message', payload: { type: 'event', event: { id: 8, taskId: 'TASK-0042', type: 'STAGE_PASSED', stageId: null, message: 'Investigate passed', data: {}, at: '2026-09-23T10:00:04.000Z' } } }] });
    expect((await conn.next('sync.ack')).payload.upToSeq).toBe(4);
    expect((await cloud.d1(`SELECT COUNT(*) AS n FROM cloud_task_events WHERE node_id = '${node.nodeId}'`))[0].n).toBe(2);
    expect((await cloud.d1(`SELECT COUNT(*) AS n FROM cloud_usage_events WHERE node_id = '${node.nodeId}'`))[0].n).toBe(1);
    expect((await cloud.d1(`SELECT status, version FROM cloud_tasks WHERE node_id = '${node.nodeId}'`))[0]).toEqual({ status: 'RUNNING', version: 3 });
    expect((await cloud.d1(`SELECT last_event_seq FROM nodes WHERE id = '${node.nodeId}'`))[0].last_event_seq).toBe(4);
    // On reconnect the welcome carries the cursor, so the node resends nothing already stored.
    conn.ws.close();
    const again = await node.connect();
    expect(again.welcome.payload.ackedSeq).toBe(4);
    again.ws.close();
  });

  it('rejects malformed and oversize frames without storing anything', async () => {
    const node = await manualNode();
    const conn = await node.connect();
    conn.ws.send('{not json');
    conn.ws.send(JSON.stringify(frame({ type: 'shell.exec', payload: { command: 'whoami' } })));
    conn.send('event.batch', { events: Array.from({ length: 201 }, (_, i) => ({ seq: i + 1, kind: 'message', payload: {} })) });
    conn.send('node.heartbeat', { activeTasks: 0, outboxDepth: 0 });
    await new Promise((r) => setTimeout(r, 500));
    expect((await cloud.d1(`SELECT last_event_seq FROM nodes WHERE id = '${node.nodeId}'`))[0].last_event_seq).toBe(0);
    expect(conn.ws.readyState).toBe(WebSocket.OPEN);
    conn.ws.close();
  });
});

describe('objects in R2', () => {
  it('stores only hash-verified, shareable objects and serves them only to signed-in people', async () => {
    const node = await manualNode();
    const session = await node.session();
    const content = Buffer.from('# Final report\n\nAll checks passed.\n');
    const sha = createHash('sha256').update(content).digest('hex');
    const put = (artifactId: string, headers: Record<string, string>, body: Buffer = content) =>
      fetch(`${cloud.url}/node/v1/artifacts/${artifactId}`, { method: 'PUT', headers: { authorization: `Bearer ${session}`, 'content-type': 'text/markdown', 'x-acc-task-id': 'TASK-0042', 'x-acc-name': 'final-report.md', ...headers }, body });

    expect((await put('art-1', { 'x-acc-sha256': sha, 'x-acc-sensitivity': 'safe_sync' })).status).toBe(201);
    expect((await put('art-2', { 'x-acc-sha256': 'a'.repeat(64), 'x-acc-sensitivity': 'safe_sync' })).status).toBe(422);
    expect((await put('art-3', { 'x-acc-sha256': sha, 'x-acc-sensitivity': 'local_only' })).status).toBe(403);
    expect((await fetch(`${cloud.url}/node/v1/artifacts/art-4`, { method: 'PUT', headers: { 'x-acc-sha256': sha, 'x-acc-task-id': 'T', 'x-acc-sensitivity': 'safe_sync' }, body: content })).status).toBe(401);

    const manifests = await cloud.d1(`SELECT artifact_id, status, sha256 FROM artifact_manifests WHERE node_id = '${node.nodeId}' ORDER BY artifact_id`);
    expect(manifests).toEqual([
      { artifact_id: 'art-1', status: 'uploaded', sha256: sha },
      { artifact_id: 'art-2', status: 'failed', sha256: 'a'.repeat(64) },
    ]);
    // Download: authenticated, byte-identical, hash in the header.
    const token = await cloud.signer.token();
    const download = await fetch(`${cloud.url}/api/cloud/artifacts/${node.nodeId}/art-1`, { headers: { 'cf-access-jwt-assertion': token } });
    expect(download.status).toBe(200);
    expect(download.headers.get('x-acc-sha256')).toBe(sha);
    expect(Buffer.from(await download.arrayBuffer()).equals(content)).toBe(true);
    expect((await fetch(`${cloud.url}/api/cloud/artifacts/${node.nodeId}/art-1`)).status).toBe(401);
    expect((await fetch(`${cloud.url}/api/cloud/artifacts/${node.nodeId}/art-2`, { headers: { 'cf-access-jwt-assertion': token } })).status).toBe(404);

    // Log chunks: same verification, listed per execution.
    const chunk = Buffer.from('line 1\nline 2\n');
    const chunkSha = createHash('sha256').update(chunk).digest('hex');
    const log = await fetch(`${cloud.url}/node/v1/logs/exec-1/0`, { method: 'PUT', headers: { authorization: `Bearer ${session}`, 'x-acc-sha256': chunkSha, 'x-acc-task-id': 'TASK-0042', 'x-acc-first-seq': '0', 'x-acc-last-seq': '1' }, body: chunk });
    expect(log.status).toBe(201);
    const listed = await cloud.api('GET', `/api/cloud/logs/${node.nodeId}/exec-1`);
    expect(listed.body).toEqual([{ chunk_index: 0, first_seq: 0, last_seq: 1, sha256: chunkSha, size: chunk.length }]);
    expect((await cloud.api('GET', `/api/cloud/logs/${node.nodeId}/exec-1?chunk=0`)).body).toBe('line 1\nline 2\n');
  });
});

describe('browser fan-out', () => {
  it('relays a node\'s events to signed-in browsers, tagged with the node', async () => {
    const node = await manualNode();
    const conn = await node.connect();
    const token = await cloud.signer.token();
    const browser = new WebSocket(`${cloud.url.replace('http', 'ws')}/ws`, { headers: { 'cf-access-jwt-assertion': token, origin: cloud.url } });
    const got: any[] = [];
    browser.on('message', (d) => got.push(JSON.parse(d.toString())));
    await new Promise((resolve) => browser.once('open', resolve));
    conn.send('event.live', { message: { type: 'stage', stage: { id: 's1', taskId: 'TASK-9', status: 'RUNNING' } } });
    conn.send('event.batch', { events: [{ seq: 1, kind: 'message', payload: { type: 'task', task: { id: 'TASK-9', title: 't', status: 'RUNNING', version: 1, createdAt: 'x', updatedAt: 'x' } } }] });
    await conn.next('sync.ack');
    const start = Date.now();
    while (Date.now() - start < 5_000 && got.filter((m) => m.type === 'stage' || m.type === 'task').length < 2) await new Promise((r) => setTimeout(r, 25));
    expect(got.find((m) => m.type === 'hello')).toBeTruthy();
    expect(got.find((m) => m.type === 'stage')).toMatchObject({ nodeId: node.nodeId, stage: { id: 's1' } });
    expect(got.find((m) => m.type === 'task')).toMatchObject({ nodeId: node.nodeId, task: { id: 'TASK-9' } });
    // Logs reach only browsers that subscribed to that execution, and the node learns who watches.
    conn.send('event.live', { message: { type: 'logs', taskId: 'TASK-9', executionId: 'e1', lines: [] } });
    browser.send(JSON.stringify({ type: 'subscribeLogs', executionId: 'e1' }));
    let subscribed: any = null;
    for (let i = 0; i < 5 && !subscribed?.payload.logs.includes('e1'); i++) subscribed = await conn.next('subscriptions');
    expect(subscribed.payload.logs).toEqual(['e1']);
    conn.send('event.live', { message: { type: 'logs', taskId: 'TASK-9', executionId: 'e1', lines: [{ seq: 1, text: 'hi' }] } });
    const s2 = Date.now();
    while (Date.now() - s2 < 5_000 && !got.some((m) => m.type === 'logs')) await new Promise((r) => setTimeout(r, 25));
    expect(got.filter((m) => m.type === 'logs')).toHaveLength(1);
    browser.close();
    conn.ws.close();
  });
});
