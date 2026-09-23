import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetSharedRedactor } from '@acc/security';
import { addRepo, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from '../../orchestrator/test/helpers.js';
import { startCloud, type Cloud } from './harness.js';

/**
 * Artifacts and historical logs (CLOUD_CONTROL_PLAN Phase 8): the sync policy,
 * hash-verified R2 objects, offline reading from R2 and retention that never
 * touches the node's own files.
 */

let cloud: Cloud;
let node: TestApp;
let nodeId: string;
let taskId: string;
// Assembled at runtime: no credential-shaped literal in the repository.
const SECRET = ['upload', randomBytes(10).toString('hex')].join('-');
const h = () => ({ 'x-acc-node': nodeId });

beforeAll(async () => {
  cloud = await startCloud();
  node = await createTestApp({ remoteTimings: { uploadMs: 500 } });
  expect((await node.api('POST', '/api/credentials', { name: 'upload-secret', kind: 'other', envVar: 'UPLOAD_SECRET', value: SECRET })).status).toBe(201);
  const code = (await cloud.api('POST', '/api/cloud/pairing-tokens', { label: 'uploads' })).body.token;
  nodeId = (await node.services.remote.pair({ relayUrl: cloud.url, code, label: 'Uploads node' })).nodeId!;
  await waitFor(() => node.services.remote.status().state, (s) => s === 'connected', 30_000);
  const repoId = await addRepo(node, await makeRepo());
  taskId = (await node.api('POST', '/api/tasks', { description: `Ship the fix. Never print ${SECRET}.`, repositoryId: repoId, workflowId: 'normal-development', mode: 'autopilot' })).body.id;
  await waitForStatus(node, taskId, ['COMPLETED'], 90_000);
});
afterAll(async () => {
  await node?.close();
  await cloud?.stop();
  resetSharedRedactor();
});

describe('artifact and log uploads', () => {
  it('uploads safe artifacts with a verified hash and keeps local-only ones on the node', async () => {
    const artifacts = node.services.store.listArtifacts(taskId);
    const report = artifacts.find((a) => a.type === 'final-report')!;
    const request = artifacts.find((a) => a.type === 'request')!;
    await waitFor(async () => (await cloud.d1(`SELECT status FROM artifact_manifests WHERE artifact_id = '${report.id}'`))[0]?.status, (s) => s === 'uploaded', 30_000, 'report uploaded');
    await waitFor(async () => (await cloud.d1(`SELECT status FROM artifact_manifests WHERE artifact_id = '${request.id}'`))[0]?.status, (s) => s === 'uploaded', 30_000, 'request uploaded');
    const local = artifacts.filter((a) => ['git-diff', 'environment', 'task-json', 'tool-output', 'staged-diff'].includes(a.type));
    expect(local.length).toBeGreaterThan(0);
    for (const a of local) {
      const [m] = await cloud.d1(`SELECT status, r2_key FROM artifact_manifests WHERE artifact_id = '${a.id}'`);
      expect(m?.status ?? 'local_only').toBe('local_only');
      expect(m?.r2_key ?? null).toBeNull();
    }
    // Downloaded bytes match the recorded hash, and the planted secret is not in them.
    const download = await fetch(`${cloud.url}/api/cloud/artifacts/${nodeId}/${request.id}`, { headers: { 'cf-access-jwt-assertion': await cloud.signer.token() } });
    const bytes = Buffer.from(await download.arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(download.headers.get('x-acc-sha256'));
    expect(bytes.toString('utf8')).toContain('Ship the fix');
    expect(bytes.toString('utf8')).not.toContain(SECRET);
  });

  it('uploads finished logs as verified chunks', async () => {
    const executions = node.services.store.listExecutions(taskId);
    const withLogs = executions.find((e) => node.services.store.listLogLines(e.id, { limit: 1 }).length > 0)!;
    const chunks = await waitFor(async () => (await cloud.api('GET', `/api/cloud/logs/${nodeId}/${withLogs.id}`)).body as Array<{ sha256: string }>, (c) => Array.isArray(c) && c.length > 0, 30_000, 'log chunks');
    const text = (await cloud.api('GET', `/api/cloud/logs/${nodeId}/${withLogs.id}?chunk=0`)).body as string;
    expect(createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')).toBe(chunks[0]!.sha256);
    expect(text).not.toContain(SECRET);
  });

  it('serves stored artifacts and logs from R2 while the node is offline, and nothing local-only', async () => {
    const report = node.services.store.listArtifacts(taskId).find((a) => a.type === 'final-report')!;
    const diff = node.services.store.listArtifacts(taskId).find((a) => a.type === 'git-diff');
    const execution = node.services.store.listExecutions(taskId).find((e) => node.services.store.listLogLines(e.id, { limit: 1 }).length > 0)!;
    await node.services.remote.updatePermissions({ enabled: false });
    await waitFor(async () => (await cloud.api('GET', '/api/cloud/nodes')).body[0].status, (s) => s === 'offline', 20_000, 'offline');
    const content = await cloud.api('GET', `/api/artifacts/${report.id}/content`, undefined, h());
    expect(content).toMatchObject({ status: 200, body: { source: 'cloud' } });
    expect(content.headers.get('x-acc-source')).toBe('cache');
    expect(content.body.content).toContain('TASK COMPLETED');
    const logs = await cloud.api('GET', `/api/executions/${execution.id}/logs`, undefined, h());
    expect(logs.status).toBe(200);
    expect(logs.body.length).toBeGreaterThan(0);
    if (diff) expect((await cloud.api('GET', `/api/artifacts/${diff.id}/content`, undefined, h())).body.error.code).toBe('NODE_OFFLINE');
    await node.services.remote.updatePermissions({ enabled: true });
    await waitFor(() => node.services.remote.status().state, (s) => s === 'connected', 30_000);
  });

  it('prunes old cloud copies on schedule without touching the node', async () => {
    const report = node.services.store.listArtifacts(taskId).find((a) => a.type === 'final-report')!;
    await cloud.d1(`UPDATE artifact_manifests SET created_at = '2000-01-01T00:00:00.000Z' WHERE artifact_id = '${report.id}'`);
    await cloud.d1(`UPDATE log_chunks SET created_at = '2000-01-01T00:00:00.000Z'`);
    const [before] = await cloud.d1(`SELECT r2_key FROM artifact_manifests WHERE artifact_id = '${report.id}'`);
    expect(before.r2_key).toBeTruthy();
    const scheduled = await fetch(`${cloud.url}/cdn-cgi/local/scheduled`);
    expect(scheduled.ok).toBe(true);
    await waitFor(async () => (await cloud.d1(`SELECT COUNT(*) AS n FROM artifact_manifests WHERE artifact_id = '${report.id}'`))[0].n, (n) => n === 0, 20_000, 'manifest pruned');
    expect((await cloud.d1('SELECT COUNT(*) AS n FROM log_chunks'))[0].n).toBe(0);
    const gone = await fetch(`${cloud.url}/api/cloud/artifacts/${nodeId}/${report.id}`, { headers: { 'cf-access-jwt-assertion': await cloud.signer.token() } });
    expect(gone.status).toBe(404);
    // The node keeps its own file and record.
    expect(existsSync(node.services.artifacts.absolutePath(node.services.store.getArtifact(report.id)!))).toBe(true);
  });
});
