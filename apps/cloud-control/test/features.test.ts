import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addRepo, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from '../../orchestrator/test/helpers.js';
import { startCloud, type Cloud } from './harness.js';

/**
 * The Control Center's features through the cloud (CLOUD_CONTROL_PLAN §7 Phase 7),
 * each executed by the existing local services on a real node behind the Worker.
 */

let cloud: Cloud;
let node: TestApp;
let nodeId: string;
const h = () => ({ 'x-acc-node': nodeId });
beforeAll(async () => {
  cloud = await startCloud();
  node = await createTestApp();
  const code = (await cloud.api('POST', '/api/cloud/pairing-tokens', { label: 'features' })).body.token;
  nodeId = (await node.services.remote.pair({ relayUrl: cloud.url, code, label: 'Features node' })).nodeId!;
  await waitFor(() => node.services.remote.status().state, (s) => s === 'connected', 30_000);
});
afterAll(async () => {
  await node?.close();
  await cloud?.stop();
});

describe('features through the cloud', () => {
  it('health, agents, workflows and settings answer live, with local details removed', async () => {
    const health = await cloud.api('GET', '/api/health', undefined, h());
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, simulatedAgents: true });
    expect(health.body.dataDir).toBeUndefined();
    const agents = await cloud.api('GET', '/api/agents', undefined, h());
    expect(agents.body.map((a: { id: string }) => a.id).sort()).toEqual(['claude', 'codex']);
    for (const a of agents.body) expect(a.detection.executablePath).toBeNull();
    expect((await cloud.api('GET', '/api/workflows', undefined, h())).body.length).toBeGreaterThan(1);
    expect((await cloud.api('GET', '/api/settings', undefined, h())).body.billingMode).toBe('subscription');
  });

  it('tools and credentials show metadata only; values never leave the node', async () => {
    const value = ['cred', randomBytes(12).toString('hex')].join('-');
    expect((await node.api('POST', '/api/credentials', { name: 'deploy-token', kind: 'other', envVar: 'DEPLOY_TOKEN', value })).status).toBe(201);
    const creds = await cloud.api('GET', '/api/credentials', undefined, h());
    expect(creds.body.find((c: { name: string }) => c.name === 'deploy-token')).toMatchObject({ fingerprint: expect.any(String) });
    expect(JSON.stringify(creds.body)).not.toContain(value);
    // Creating or changing a value is not a remote operation at all.
    expect((await cloud.api('POST', '/api/credentials', { name: 'x', kind: 'other', value: 'abcdefghij' }, h())).status).toBe(404);
    const tools = await cloud.api('GET', '/api/tools', undefined, h());
    expect(tools.status).toBe(200);
    expect(tools.body.length).toBeGreaterThan(3);
    expect(JSON.stringify(tools.body)).not.toMatch(/[A-Za-z]:\\\\(?:Program|Users)/);
  });

  it('runs a task to its test results and serves artifacts by the sync policy', async () => {
    const repoId = await addRepo(node, await makeRepo());
    await waitFor(async () => (await cloud.d1(`SELECT COUNT(*) AS n FROM node_repositories WHERE node_id = '${nodeId}'`))[0].n, (n) => n >= 1, 20_000);
    const created = await cloud.api('POST', '/api/tasks', { description: 'Feature run', repositoryId: repoId, workflowId: 'normal-development', mode: 'autopilot' }, h());
    expect(created.status).toBe(201);
    const taskId = created.body.id as string;
    await waitForStatus(node, taskId, ['COMPLETED'], 90_000);
    const tests = await cloud.api('GET', `/api/tasks/${taskId}/tests`, undefined, h());
    expect(tests.body.some((r: { status: string }) => r.status === 'PASSED' || r.status === 'passed' || r.status === 'SUCCESS')).toBe(true);
    const artifacts = (await cloud.api('GET', `/api/tasks/${taskId}/artifacts`, undefined, h())).body as Array<{ id: string; type: string; name: string }>;
    const report = artifacts.find((a) => a.type === 'final-report')!;
    const diff = artifacts.find((a) => a.type === 'git-diff');
    const content = await cloud.api('GET', `/api/artifacts/${report.id}/content`, undefined, h());
    expect(content.status).toBe(200);
    expect(content.body.content).toContain('TASK COMPLETED');
    if (diff) expect((await cloud.api('GET', `/api/artifacts/${diff.id}/content`, undefined, h())).body.error.code).toBe('REMOTE_FORBIDDEN');
    // Logs of a finished execution are readable live.
    const executions = (await cloud.api('GET', `/api/tasks/${taskId}/executions`, undefined, h())).body as Array<{ id: string }>;
    expect((await cloud.api('GET', `/api/executions/${executions[0]!.id}/logs`, undefined, h())).status).toBe(200);
  });

  it('keeps the typed confirmation for a dangerous command through the cloud', async () => {
    const repoId = await addRepo(node, await makeRepo({ scripts: { test: 'node -e "0"', build: 'node -e "0" && git reset --hard' } }));
    const created = await cloud.api('POST', '/api/tasks', { description: 'Dangerous build from the cloud', repositoryId: repoId, workflowId: 'normal-development', mode: 'autopilot' }, h());
    const taskId = created.body.id as string;
    await waitForStatus(node, taskId, ['WAITING_FOR_USER'], 90_000);
    const approval = (await waitFor(async () => (await cloud.api('GET', '/api/approvals', undefined, h())).body.find((a: { taskId: string }) => a.taskId === taskId), Boolean, 20_000, 'approval')) as { id: string };
    await waitFor(async () => (await cloud.d1(`SELECT COUNT(*) AS n FROM cloud_entities WHERE kind = 'approval' AND entity_id = '${approval.id}'`))[0].n, (n) => n === 1, 20_000, 'approval mirrored');
    const noPhrase = await cloud.api('POST', `/api/approvals/${approval.id}/approve`, { confirmation: 'yes' }, h());
    expect(noPhrase.status).toBe(422);
    const typed = await cloud.api('POST', `/api/approvals/${approval.id}/approve`, { confirmation: taskId }, h());
    expect(typed.status).toBe(200);
    expect((await waitForStatus(node, taskId, ['COMPLETED', 'FAILED'], 90_000)).status).toBe('COMPLETED');
  });

  it('opens a remote terminal only with an explicit confirmation and a recent sign-in', async () => {
    const repoId = (await node.api('GET', '/api/repositories')).body[0].id as string;
    const unconfirmed = await cloud.api('POST', '/api/terminals', { repositoryId: repoId }, h());
    expect(unconfirmed).toMatchObject({ status: 428, body: { error: { code: 'CONFIRMATION_REQUIRED' } } });
    const stale = await cloud.signer.token({ iat: Math.floor(Date.now() / 1000) - 2 * 3600 });
    const old = await fetch(`${cloud.url}/api/terminals`, { method: 'POST', headers: { 'cf-access-jwt-assertion': stale, origin: cloud.url, 'content-type': 'application/json', 'x-acc-confirm': 'open-terminal', 'x-acc-node': nodeId }, body: JSON.stringify({ repositoryId: repoId }) });
    expect(old.status).toBe(401);
    // Confirmed and recent: the node still refuses until remote terminals are turned on locally.
    const offLocally = await cloud.api('POST', '/api/terminals', { repositoryId: repoId }, { ...h(), 'x-acc-confirm': 'open-terminal' });
    expect(offLocally).toMatchObject({ status: 403, body: { error: { code: 'REMOTE_FORBIDDEN' } } });
  });

  it('usage reads live and from the mirror when the node is away', async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const live = await cloud.api('GET', `/api/usage/events?from=${from}&to=${to}&limit=50`, undefined, h());
    expect(live.status).toBe(200);
    expect(live.headers.get('x-acc-source')).toBe('live');
    await waitFor(async () => (await cloud.d1(`SELECT COUNT(*) AS n FROM cloud_usage_events WHERE node_id = '${nodeId}'`))[0].n, (n) => n > 0, 20_000, 'usage mirrored');
    await node.services.remote.updatePermissions({ enabled: false });
    await waitFor(async () => (await cloud.api('GET', '/api/cloud/nodes')).body[0].status, (s) => s === 'offline', 20_000, 'offline');
    const cached = await cloud.api('GET', `/api/usage/events?from=${from}&to=${to}&limit=50`, undefined, h());
    expect(cached.headers.get('x-acc-source')).toBe('cache');
    expect(cached.body.items.length).toBeGreaterThan(0);
    expect((await cloud.api('GET', `/api/usage/overview?from=${from}&to=${to}`, undefined, h())).body.error.code).toBe('NODE_OFFLINE');
    await node.services.remote.updatePermissions({ enabled: true });
    await waitFor(() => node.services.remote.status().state, (s) => s === 'connected', 30_000);
  });
});
