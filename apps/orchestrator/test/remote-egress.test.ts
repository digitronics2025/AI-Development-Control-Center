import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentExecutionInput, AgentExecutionResult } from '@acc/agent-sdk';
import { resetSharedRedactor } from '@acc/security';
import { EgressSanitizer, stripLocalFields } from '../src/remote/egress.js';
import { FakeRelay } from './fake-relay.js';
import { addRepo, createTask, createTestApp, makeRepo, simAdapters, TOKEN, waitFor, waitForStatus, type TestApp } from './helpers.js';

// Assembled at runtime: no credential-shaped literal in the repository.
const ENV_SECRET = ['envsecret', randomBytes(8).toString('hex')].join('-');
const CREDENTIAL_VALUE = ['credvalue', randomBytes(8).toString('hex')].join('-');

beforeAll(() => {
  process.env.ACC_TEST_SERVICE_TOKEN = ENV_SECRET;
  resetSharedRedactor();
});
afterAll(() => {
  delete process.env.ACC_TEST_SERVICE_TOKEN;
  resetSharedRedactor();
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function paired(adapters?: AgentAdapter[]): Promise<{ r: FakeRelay; t: TestApp; nodeId: string }> {
  const r = await new FakeRelay().start();
  cleanups.push(() => r.stop());
  const t = await createTestApp(adapters ? { adapters } : {});
  cleanups.push(() => t.close());
  const { nodeId } = await t.services.remote.pair({ relayUrl: r.url, code: r.newPairingToken(), label: 'PC' });
  await waitFor(() => t.services.remote.status().state, (s) => s === 'connected', 15_000, 'connected');
  return { r, t, nodeId: nodeId! };
}

/** Every spelling a Windows path takes inside JSON text. */
function spellings(p: string): string[] {
  return [p, p.replace(/\\/g, '/'), p.replace(/\\/g, '\\\\'), p.toLowerCase(), p.replace(/\\/g, '/').toLowerCase()];
}

describe('cloud egress', () => {
  it('never lets a credential, the local token, an environment secret or a local path leave the node', async () => {
    const { r, t, nodeId } = await paired();
    const repoPath = await makeRepo();
    const repoId = await addRepo(t, repoPath);
    expect((await t.api('POST', '/api/credentials', { name: 'deploy-key', kind: 'other', envVar: 'DEPLOY_KEY', value: CREDENTIAL_VALUE })).status).toBe(201);
    const secrets = `token ${TOKEN} env ${ENV_SECRET} credential ${CREDENTIAL_VALUE} path ${repoPath}`;
    const taskId = await createTask(t, repoId, `Handle this carefully: ${secrets}`);
    await waitForStatus(t, taskId, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);

    // Commands, live reads and mirrored snapshots all carry the same material.
    const directive = await r.command(nodeId, 'task.directive', { id: taskId }, { text: `Remember ${secrets}` });
    r.deliver(directive);
    await waitFor(() => r.results.get(directive.id)?.length ?? 0, (n) => n > 0, 15_000);
    await r.rpc('repository.list');
    await r.rpc('repository.get', { id: repoId });
    await r.rpc('task.get', { id: taskId });
    await r.rpc('task.events', { id: taskId });
    await r.rpc('credential.list');
    await r.rpc('settings.get');
    await r.rpc('agent.list');
    const executions = (await t.api('GET', `/api/tasks/${taskId}/executions`)).body as Array<{ id: string }>;
    for (const e of executions.slice(0, 3)) await r.rpc('execution.logs', { id: e.id });
    await waitFor(() => r.events.some((e) => e.kind === 'taskDetail' && e.payload.taskId === taskId), Boolean, 15_000, 'detail snapshot');

    const wire = JSON.stringify(r.frames);
    expect(wire.length).toBeGreaterThan(5_000);
    expect(wire).toContain(taskId);
    for (const needle of [TOKEN, ENV_SECRET, CREDENTIAL_VALUE, ...spellings(repoPath)]) expect(wire, `leaked: ${needle}`).not.toContain(needle);
    // What does leave: the repository by name, the credential by fingerprint, placeholders for paths.
    expect(wire).toContain('deploy-key');
    expect(wire).toMatch(/\[REDACTED\]/);
  });

  it('buffers while the cloud is away and delivers in order after it returns', async () => {
    const { r, t } = await paired();
    const repoId = await addRepo(t, await makeRepo());
    await waitFor(() => t.services.remote.store.outboxDepth(), (n) => n === 0, 10_000, 'initial drain');
    const before = r.ackedSeq;
    await r.stop();
    await waitFor(() => t.services.remote.status().state, (s) => s === 'offline', 15_000, 'offline');
    const taskId = await createTask(t, repoId, 'Work while the cloud is down');
    await waitForStatus(t, taskId, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(t.services.remote.store.outboxDepth()).toBeGreaterThan(3);
    await r.restart();
    await waitFor(() => t.services.remote.store.outboxDepth(), (n) => n === 0, 30_000, 'outbox drained');
    const delivered = r.events.filter((e) => e.seq > before);
    const seqs = delivered.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const lastTask = delivered.filter((e) => e.payload?.type === 'task' && e.payload.task.id === taskId).at(-1);
    expect(lastTask?.payload.task.status).toBe('COMPLETED');
  });

  it('resends unacknowledged events after a reconnect without losing any', async () => {
    const { r, t } = await paired();
    const repoId = await addRepo(t, await makeRepo());
    await waitFor(() => t.services.remote.store.outboxDepth(), (n) => n === 0, 10_000);
    const startIndex = r.events.length;
    r.ackBatches = false;
    const taskId = await createTask(t, repoId, 'Unacknowledged burst', { start: false });
    const key = (e: { kind: string; payload: any }) => (e.kind === 'taskDetail' ? `detail:${e.payload.taskId}` : `${e.payload.type}:${e.payload.task?.id ?? e.payload.event?.id ?? e.payload.repository?.id ?? ''}`);
    await waitFor(() => r.events.filter((e) => e.kind === 'taskDetail' && e.payload.taskId === taskId).length, (n) => n > 0, 10_000, 'unacknowledged detail');
    const firstKeys = new Set(r.events.slice(startIndex).map(key));
    const firstCount = r.events.length;
    expect(t.services.remote.store.outboxDepth()).toBeGreaterThan(0);
    r.ackBatches = true;
    r.dropConnections();
    await waitFor(() => t.services.remote.store.outboxDepth(), (n) => n === 0, 20_000, 'acknowledged after resend');
    const resentKeys = new Set(r.events.slice(firstCount).map(key));
    for (const k of firstKeys) expect(resentKeys.has(k), `resent ${k}`).toBe(true);
    expect(t.services.remote.store.syncState().ackedSeq).toBe(r.ackedSeq);
  });
});

/** A Chairman model that repeats whatever it is given — the worst case for what its answers may carry. */
class EchoingChairman implements AgentAdapter {
  readonly id = 'echo';
  readonly displayName = 'Echoing Chairman';
  readonly usageCapabilities = { provider: 'simulated', tokenUsage: false, providerCost: false, credit: false, quota: false, rateLimits: false, cacheTokens: false, reasoningTokens: false, resetTime: false };
  constructor(private readonly leak: string) {}
  async detect() {
    return { found: true, executablePath: 'x', version: '1', error: null };
  }
  async healthCheck() {
    return { state: 'connected' as const, message: 'ok', authMethod: 'test', billing: 'subscription' as const, checkedAt: new Date().toISOString() };
  }
  async getCapabilities() {
    return { repositoryRead: true, repositoryWrite: false, commandExecution: false, images: false, interactive: false, nonInteractive: true, modelSelection: false, effortSelection: false };
  }
  async listModels() {
    return [];
  }
  async execute(input: AgentExecutionInput) {
    const choice = /^Candidate ids: ([^,\n]+)/m.exec(input.prompt)?.[1]?.trim() ?? 'none';
    const leak = this.leak;
    const output = `\`\`\`json\n${JSON.stringify({ choice, summary: `Chose ${choice}; saw ${leak}`, reasoningSummary: `Evidence: ${leak}`, guidance: 'Take a different approach.', expectedResult: `No failure at ${leak}`, diagnosis: { summary: `Cause found near ${leak}`, confidence: 'HIGH' } })}\n\`\`\``;
    const now = new Date().toISOString();
    const result: AgentExecutionResult = { executionId: input.executionId, status: 'succeeded', exitCode: 0, output, errorClass: null, errorMessage: null, durationMs: 1, startedAt: now, finishedAt: now, sessionId: null, filesChanged: [], usage: null, capacity: [] };
    return { executionId: input.executionId, pid: null, commandLine: 'echo', done: Promise.resolve(result) };
  }
  async cancel() {}
  async parseResult(): Promise<AgentExecutionResult> {
    throw new Error('unused');
  }
}

describe('Chairman strategy data on the wire', () => {
  it('keeps diagnosis, outcomes and evidence metadata free of secrets and local paths', async () => {
    const repoPath = await makeRepo({
      scripts: { test: 'node check.js' },
      files: {
        'check.js': [
          "const fs = require('fs');",
          "const n = fs.existsSync('sim-output.md') ? fs.readFileSync('sim-output.md', 'utf8').split('\\n').filter(Boolean).length : 0;",
          `if (n < 4) { console.log('FAIL test/a.test.js > adds'); console.log('token ${ENV_SECRET} in ' + process.cwd() + '\\\\src\\\\add.js'); console.log('1 failed, 3 passed'); process.exit(1); }`,
          "console.log('4 passed');",
        ].join('\n'),
      },
    });
    const { r, t } = await paired([...simAdapters(), new EchoingChairman(`${ENV_SECRET} in ${repoPath}\\src\\add.js`)]);
    const current = (await t.api('GET', '/api/settings')).body.chairman;
    expect((await t.api('PATCH', '/api/settings', { chairman: { ...current, agentId: 'echo' } })).status).toBe(200);
    const taskId = await createTask(t, await addRepo(t, repoPath), 'Stalls, then recovers');
    await waitForStatus(t, taskId, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);

    const decision = t.services.chairman.store.listDecisions(taskId).find((d) => d.strategyFingerprint)!;
    expect(decision.strategy).toMatchObject({ status: 'SUCCEEDED', diagnosis: { source: 'model', confidence: 'HIGH' } });
    // Redacted before it was stored: the database never held the secret.
    const stored = JSON.stringify(decision);
    expect(stored).not.toContain(ENV_SECRET);
    expect(decision.strategy!.diagnosis.summary).toContain('[REDACTED]');

    // Everything the cloud saw: live decisions (first open, then with the outcome), mirrored events, and an overview read.
    await r.rpc('chairman.overview', { id: taskId });
    await waitFor(() => r.events.some((e) => e.kind === 'taskDetail' && e.payload.taskId === taskId), Boolean, 15_000, 'detail snapshot');
    const wire = JSON.stringify(r.frames);
    const liveDecisions = r.frames.filter((f) => f.type === 'event.live' && (f.payload as { message: { type: string } }).message.type === 'chairman.decision');
    const statuses = liveDecisions.map((f) => (f.payload as { message: { decision: { id: string; strategy?: { status: string } | null } } }).message.decision).filter((d) => d.id === decision.id).map((d) => d.strategy?.status);
    expect(statuses).toEqual(['RUNNING', 'SUCCEEDED']);
    expect(wire).toContain('Cause found near');
    for (const needle of [ENV_SECRET, ...spellings(repoPath)]) expect(wire, `leaked: ${needle}`).not.toContain(needle);
  });
});

describe('egress field rules', () => {
  const sanitizer = new EgressSanitizer({ repositories: [{ path: 'C:\\Work\\secret-project', name: 'secret-project' }], dataDir: 'C:\\Users\\me\\AppData\\Local\\AIDevControlCenter', homeDir: 'C:\\Users\\me' });

  it('drops message types that must never leave', () => {
    expect(sanitizer.message({ type: 'hello', version: 'x', serverTime: '', startedAt: '' })).toBeNull();
    expect(sanitizer.message({ type: 'terminal.output', terminalId: 't1', data: 'PS> dir', cursor: 1 })).toBeNull();
    expect(sanitizer.message({ type: 'terminal.output', terminalId: 't1', data: 'PS> dir', cursor: 1 }, () => true)).not.toBeNull();
    expect(sanitizer.message({ type: 'remote.status', status: {} as never })).toBeNull();
  });

  it('removes local paths, executables and secret-named keys, keeping repository-relative paths', () => {
    const out = stripLocalFields({
      repository: { id: 'r', name: 'n', path: 'C:\\Work\\secret-project', gitMode: 'branch', commands: [] },
      task: { git: { worktreePath: 'C:\\Users\\me\\AppData\\Local\\AIDevControlCenter\\worktrees\\t' }, attachments: [{ name: 'a.png', size: 3, path: 'C:\\x\\a.png' }] },
      agent: { detection: { executablePath: 'C:\\bin\\claude.exe' } },
      change: { path: 'src/index.ts', status: 'modified' },
      health: { simulatedAgents: false, billingMode: 'subscription', dataDir: 'C:\\d', host: '127.0.0.1', port: 4317 },
    }) as any;
    expect(out.repository.path).toBe('');
    expect(out.task.git.worktreePath).toBeNull();
    expect(out.task.attachments[0]).toEqual({ name: 'a.png', size: 3 });
    expect(out.agent.detection.executablePath).toBeNull();
    expect(out.change.path).toBe('src/index.ts');
    expect(out.health).toEqual({ simulatedAgents: false, billingMode: 'subscription' });
    const scrubbed = sanitizer.scrub({ env: { A: 'b' }, authorization: 'x', nested: { apiKey: 'k', text: 'opened C:\\Work\\secret-project\\src\\a.ts and C:/Users/me/notes.txt and D:\\Other\\file.log' } }) as any;
    expect(scrubbed.env).toBeUndefined();
    expect(scrubbed.authorization).toBeUndefined();
    expect(scrubbed.nested.apiKey).toBeUndefined();
    expect(scrubbed.nested.text).toBe(`opened <repo:secret-project>${path.sep === '\\' ? '\\' : '\\'}src\\a.ts and <home>/notes.txt and <path>/file.log`);
  });

  it('scrubs JSON-escaped drive paths and network shares, and leaves ordinary text alone', () => {
    expect(sanitizer.scrubText('"D:\\\\Other\\\\secret\\\\plan.txt"')).toBe('"<path>/plan.txt"');
    expect(sanitizer.scrubText('ran \\\\fileserver\\team\\secret\\tool.exe')).toBe('ran <path>/tool.exe');
    expect(sanitizer.scrubText('"\\\\\\\\fileserver\\\\team\\\\tool.exe"')).toBe('"<path>/tool.exe"');
    expect(sanitizer.scrubText('ratio 3:4, a \\n escape and https://example.com/a/b')).toBe('ratio 3:4, a \\n escape and https://example.com/a/b');
  });
});

describe('uploads', () => {
  it('records a failed upload for retry and never touches the task', async () => {
    // The fake relay has no upload endpoint: every upload fails, as in an R2 outage.
    const r = await new FakeRelay().start();
    cleanups.push(() => r.stop());
    const t = await createTestApp({ remoteTimings: { uploadMs: 300 } });
    cleanups.push(() => t.close());
    await t.services.remote.pair({ relayUrl: r.url, code: r.newPairingToken(), label: 'PC' });
    await waitFor(() => t.services.remote.status().state, (s) => s === 'connected', 15_000);
    const taskId = await createTask(t, await addRepo(t, await makeRepo()), 'Upload outage');
    expect((await waitForStatus(t, taskId, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000)).status).toBe('COMPLETED');
    const report = t.services.store.listArtifacts(taskId).find((a) => a.type === 'final-report')!;
    const synced = await waitFor(() => t.services.remote.store.syncObject(`artifact:${report.id}`), (o) => o?.status === 'failed', 20_000, 'failed upload recorded');
    expect(synced).toMatchObject({ attempts: 1, sensitivity: 'safe_sync' });
    expect(synced!.nextAttemptAt).toBeTruthy();
    const diff = t.services.store.listArtifacts(taskId).find((a) => a.type === 'git-diff');
    // The simulated implementer changes the repository, so a diff always exists; it never leaves the machine.
    expect(diff).toBeDefined();
    expect(t.services.remote.store.syncObject(`artifact:${diff!.id}`)).toMatchObject({ status: 'local_only' });
    // The manifest tells the cloud the truth: pending retry, not uploaded.
    const manifests = r.frames.filter((f) => f.type === 'artifact.manifest').map((f) => f.payload as { artifactId: string; status: string });
    expect(manifests.filter((m) => m.artifactId === report.id).map((m) => m.status)).not.toContain('uploaded');
    expect(t.services.store.getTask(taskId)!.status).toBe('COMPLETED');
  });
});
