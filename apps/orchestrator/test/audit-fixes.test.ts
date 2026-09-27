import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter, type AgentExecutionHandle, type AgentExecutionInput } from '@acc/agent-sdk';
import { setSelfReferences } from '@acc/security';
import { stageCommandRisk } from '../src/engine/runners.js';
import { TerminalGrants } from '../src/remote/terminal-grants.js';
import { preflightFindings, withoutSensitiveFiles } from '../src/source-control/preflight.js';
import type { ToolScope } from '../src/tools/service.js';
import { addRepo as addRepoTo, createTask, createTestApp, makeRepo, waitFor, waitForStatus, IN_PLACE, type TestApp } from './helpers.js';

// These tests cover tasks that work in your own folder on a task branch, the mode new repositories no longer get by default.
const addRepo = (app: TestApp, repoPath: string) => addRepoTo(app, repoPath, IN_PLACE);

/**
 * Regression tests for the 2026-09-24 pre-release audit
 * (docs/security/prerelease-audit-2026-09-24.md). Each test names its finding.
 */

let t: TestApp;
let work: string;

beforeAll(async () => {
  t = await createTestApp();
  work = mkdtempSync(path.join(os.tmpdir(), 'acc-audit-'));
  setSelfReferences({ dataDir: t.dataDir, port: 4317 });
});
afterAll(async () => {
  setSelfReferences({});
  await t.close();
});

function scope(overrides: Partial<ToolScope> = {}): ToolScope {
  return {
    taskId: null,
    stageId: null,
    sessionId: null,
    repositoryId: null,
    cwd: work,
    roots: [work],
    stageLevel: 4,
    autoApproveUpToLevel: 4,
    mode: 'full',
    profile: 'operator',
    escalated: new Set(),
    protectedPaths: [],
    ...overrides,
  };
}

describe('F-02: an agent cannot reach the Control Center itself through any tool', () => {
  it.each([
    ['http.request', { method: 'POST', url: 'http://127.0.0.1:4317/api/approvals/x/approve' }],
    ['http.request', { method: 'GET', url: 'http://localhost:4317/' }],
    ['web.read', { url: 'http://127.0.0.1:4317/' }],
    ['shell.run', { script: 'Get-Content "$env:LOCALAPPDATA\\AIDevControlCenter\\auth-token"' }],
  ])('%s %j is denied before it runs', async (capability, input) => {
    const outcome = await t.services.tools.invoke({ capability, input, origin: 'agent', scope: scope() });
    expect(outcome.decision).toBe('deny');
    expect(outcome.result.summary).toMatch(/Control Center's own token, data folder or API/);
    expect(outcome.execution.status).toBe('denied');
  });

  it('names the actual data folder too', async () => {
    const outcome = await t.services.tools.invoke({ capability: 'shell.run', input: { script: `dir "${path.join(t.dataDir, 'tasks')}"` }, origin: 'agent', scope: scope() });
    expect(outcome.decision).toBe('deny');
  });

  it('leaves an ordinary loopback app alone', async () => {
    const outcome = await t.services.tools.invoke({ capability: 'http.request', input: { method: 'GET', url: 'http://127.0.0.1:9/' }, origin: 'agent', scope: scope() });
    expect(outcome.decision).not.toBe('deny');
  });
});

describe('F-54: switching to API billing needs the typed phrase on the server', () => {
  it('refuses the bare patch, accepts the phrase, and needs nothing to switch back', async () => {
    const bare = await t.api('PATCH', '/api/settings', { billingMode: 'api' });
    expect(bare.status).toBe(422);
    expect(bare.body.error.code).toBe('CONFIRMATION_REQUIRED');
    expect((await t.api('GET', '/api/settings')).body.billingMode).toBe('subscription');
    expect((await t.api('PATCH', '/api/settings', { billingMode: 'api', confirmation: 'api billing' })).status).toBe(422);
    const typed = await t.api('PATCH', '/api/settings', { billingMode: 'api', confirmation: 'API BILLING' });
    expect(typed.status).toBe(200);
    expect(typed.body.billingMode).toBe('api');
    expect(typed.body).not.toHaveProperty('confirmation');
    const back = await t.api('PATCH', '/api/settings', { billingMode: 'subscription' });
    expect(back.body.billingMode).toBe('subscription');
  });
});

describe('F-06: READY needs a passing test run after the last change', async () => {
  const { buildFinalReport } = await import('../src/engine/report.js');
  const at = (m: number) => new Date(Date.UTC(2026, 8, 24, 12, m)).toISOString();
  const stage = (id: string, role: string, kind: string, status: string, m: number) => ({ id, role, kind, status, createdAt: at(m), name: id, summary: null, verdict: null, errorMessage: null }) as never;
  const run = (stageId: string, status: string) => ({ id: `${stageId}-run`, stageId, kind: 'test', name: 'test', status, durationMs: 1, summary: null }) as never;
  const task = {
    id: 'TASK-0001', title: 'x', description: 'x', mode: 'autopilot', supervised: false, fixCycles: 0, maxFixCycles: 3, recoveryCycle: 0,
    git: { baselineBranch: 'main', baselineCommit: null, taskBranch: null, isolated: false, commits: [] }, workflow: { name: 'W', stages: [{ key: 'test', kind: 'tests' }] },
  } as never;
  const repo = { name: 'r', path: '/r' } as never;
  const report = (stages: never[], testRuns: never[]) => buildFinalReport({ task, repo, stages, testRuns, files: [], testsSkipped: false, deployed: 'none' });

  it('is READY when the last finished test stage passed after the last write', () => {
    expect(report([stage('impl', 'implementer', 'agent', 'SUCCESS', 1), stage('t1', 'tester', 'tests', 'SUCCESS', 2)], [run('t1', 'passed')]).finalStatus).toBe('READY');
  });

  it('ignores a cancelled test instance and asks for action when no run finished after the change', () => {
    const r = report([stage('impl', 'implementer', 'agent', 'SUCCESS', 1), stage('t1', 'tester', 'tests', 'CANCELLED', 2)], [run('t1', 'not_run')]);
    expect(r.finalStatus).toBe('NEEDS_USER_ACTION');
    expect(r.limitations).toContain('No test stage ran.');
  });

  it('asks for action when a fixer changed files after the last passing run', () => {
    const r = report([stage('impl', 'implementer', 'agent', 'SUCCESS', 1), stage('t1', 'tester', 'tests', 'SUCCESS', 2), stage('fix', 'fixer', 'agent', 'SUCCESS', 3)], [run('t1', 'passed')]);
    expect(r.finalStatus).toBe('NEEDS_USER_ACTION');
    expect(r.limitations).toContain('Tests have not run since the last change.');
  });

  it('asks for action when the last run passed nothing', () => {
    const r = report([stage('impl', 'implementer', 'agent', 'SUCCESS', 1), stage('t1', 'tester', 'tests', 'SUCCESS', 2)], [run('t1', 'not_run')]);
    expect(r.finalStatus).toBe('NEEDS_USER_ACTION');
  });
});

describe('F-09: an approval for a stage the workflow always asks about covers one attempt', () => {
  it('asks again when the approved staging deploy runs a second time', async () => {
    const repoId = await addRepo(t, await makeRepo({ scripts: { test: 'node -e "0"' } }));
    const repo = (await t.api('GET', `/api/repositories/${repoId}`)).body;
    await t.api('PATCH', `/api/repositories/${repoId}`, {
      commands: [
        ...repo.commands,
        { id: 'staging', name: 'staging deploy', command: 'node -e "console.log(1)"', kind: 'deploy-staging', enabled: true, timeoutSec: 60 },
        { id: 'smoke', name: 'smoke', command: 'node -e "process.exit(1)"', kind: 'smoke', enabled: true, timeoutSec: 60 },
      ],
    });
    // A required smoke test after the deploy: its failure stops the task (an optional one would only be reported).
    t.services.workflows.save('ship-twice', {
      name: 'Ship twice',
      maxFixCycles: 1,
      stages: [
        { key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, next: 'staging' },
        { key: 'staging', name: 'Staging deploy', role: 'deployer', kind: 'command', commandKinds: ['deploy-staging'], permissionLevel: 4, requiresApproval: true, next: 'smoke' },
        { key: 'smoke', name: 'Smoke test', role: 'tester', kind: 'command', commandKinds: ['smoke'], permissionLevel: 2, next: 'complete' },
      ],
    });
    const id = await createTask(t, repoId, 'Ship it twice', { workflowId: 'ship-twice' });
    await waitForStatus(t, id, ['WAITING_FOR_USER']);
    const pendingFor = async () => (await t.api('GET', '/api/approvals?status=pending')).body.filter((a: { taskId: string }) => a.taskId === id);
    const [first] = await pendingFor();
    expect(first).toMatchObject({ kind: 'stage_permission', stageKey: 'staging' });
    await t.api('POST', `/api/approvals/${first.id}/approve`, {});
    await waitFor(() => t.services.store.latestStage(id, 'staging'), (s) => s?.status === 'SUCCESS', 60_000);
    // The smoke test fails and the task stops; running staging again is a second deploy and must
    // wait for a second yes.
    await waitForStatus(t, id, ['FAILED', 'WAITING_FOR_USER'], 60_000);
    expect((await t.api('POST', `/api/tasks/${id}/retry`, { stageKey: 'staging' })).status).toBeLessThan(300);
    const again = await waitFor(pendingFor, (list) => list.some((a: { id: string; stageKey: string }) => a.id !== first.id && a.stageKey === 'staging'), 60_000);
    expect(again.length).toBe(1);
    expect(t.services.store.listStages(id).filter((s) => s.stageKey === 'staging' && s.status === 'SUCCESS')).toHaveLength(1);
    await t.api('POST', `/api/tasks/${id}/cancel`);
  }, 120_000);
});

describe('F-11: an agent a crash left running is stopped before the task resumes', () => {
  it('kills a leftover execution whose pid still belongs to that run, and leaves a reused pid alone', async () => {
    const { spawn } = await import('node:child_process');
    const { processAlive } = await import('../src/chairman/watchdog.js');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    const startedAt = new Date().toISOString();
    // A recorded start an hour off is another program that reused the pid: never killed.
    expect(await t.services.processes.stopLeftoverExecutions([{ pid, startedAt: new Date(Date.now() - 3_600_000).toISOString() }])).toBe(0);
    expect(processAlive(pid)).toBe(true);
    expect(await t.services.processes.stopLeftoverExecutions([{ pid, startedAt }, { pid: null, startedAt }])).toBe(1);
    await waitFor(() => processAlive(pid), (alive) => !alive, 15_000);
  }, 60_000);
});

describe('F-47: the secret preflight reads every file header', () => {
  it('checks added lines under a quoted or unreadable name, and keeps unreadable names out of AI context', () => {
    const secret = ['gh', 'p_', 'C'.repeat(36)].join('');
    const quoted = ['diff --git "a/we\\"ird.ts" "b/we\\"ird.ts"', 'new file mode 100644', '@@ -0,0 +1 @@', `+const t = "${secret}";`].join('\n');
    expect(preflightFindings([], quoted)).toEqual([{ path: 'we"ird.ts', reason: expect.stringContaining('GitHub token') }]);
    const odd = ['diff --git no-sides-here', '@@ -0,0 +1 @@', `+${secret}`].join('\n');
    expect(preflightFindings([], odd)).toHaveLength(1);
    expect(withoutSensitiveFiles(odd).patch).not.toContain(secret);
  });
});

describe('SEC-1: loopback aliases are the Control Center too', () => {
  it.each(['http://127.1:4317/', 'http://2130706433:4317/', 'http://[::ffff:127.0.0.1]:4317/'])('agent http.request and web.read to %s are denied as self-references', async (url) => {
    for (const [capability, input] of [
      ['http.request', { method: 'GET', url }],
      ['http.request', { method: 'GET', url, expectText: 'acc-token' }],
      ['web.read', { url }],
    ] as const) {
      const outcome = await t.services.tools.invoke({ capability, input, origin: 'agent', scope: scope() });
      expect(outcome.decision, `${capability} ${JSON.stringify(input)}`).toBe('deny');
      expect(outcome.execution.status).toBe('denied');
      expect(outcome.result.summary).toMatch(/Control Center's own token, data folder or API/);
    }
  });

  it('still runs an agent request to another loopback port', async () => {
    for (const [capability, input] of [
      ['http.request', { method: 'GET', url: 'http://127.0.0.1:9/' }],
      ['web.read', { url: 'http://127.0.0.1:9/' }],
    ] as const) {
      const outcome = await t.services.tools.invoke({ capability, input, origin: 'agent', scope: scope() });
      expect(outcome.decision, capability).toBe('allow');
      expect(outcome.execution.status).not.toBe('denied');
      expect(outcome.result.summary).not.toMatch(/Control Center's own/);
    }
  });

  it("refuses an operator's request to an alias of the listen address before it is sent", async () => {
    const outcome = await t.services.tools.invoke({ capability: 'http.request', input: { method: 'GET', url: 'http://127.1:4317/' }, origin: 'operator', scope: scope() });
    expect(outcome.result.error?.code).toBe('DENIED');
    expect(outcome.result.summary).toMatch(/Control Center's own address/);
  });

  it('holds through the curl provider, which reads a URL differently from Node', async () => {
    const curl = await t.services.tools.check('curl');
    if (!curl.installed) return;
    const http = await import('node:http');
    const hits: string[] = [];
    const listen = async () => {
      const server = http.createServer((req, res) => {
        hits.push(req.url ?? '');
        res.end('secret-dashboard');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return { server, port: (server.address() as { port: number }).port };
    };
    const self = await listen();
    const other = await listen();
    setSelfReferences({ dataDir: t.dataDir, port: self.port });
    try {
      // Node reads the host as `x`; curl, handed this text, reads `0017700000001` — 127.0.0.1 in octal.
      const tricky = (port: number) => `http://x\\@0017700000001:${port}/`;
      const agent = await t.services.tools.invoke({ capability: 'http.request', input: { method: 'GET', url: tricky(self.port), shell: 'curl' }, origin: 'agent', scope: scope() });
      expect(agent.decision).toBe('deny');
      expect(agent.result.summary).toMatch(/Control Center's own token, data folder or API/);
      const operator = await t.services.tools.invoke({ capability: 'http.request', input: { method: 'GET', url: `http://127.1:${self.port}/`, shell: 'curl' }, origin: 'operator', scope: scope() });
      expect(operator.execution.providerId).toBe('curl');
      expect(operator.result.error?.code).toBe('DENIED');
      expect(operator.result.summary).toMatch(/Control Center's own address/);
      // curl is handed the URL Node checked, so it asks host `x`, never this machine.
      const normalised = await t.services.tools.invoke({ capability: 'http.request', input: { method: 'GET', url: tricky(other.port), shell: 'curl', timeoutSec: 10 }, origin: 'operator', scope: scope() });
      expect(normalised.execution.providerId).toBe('curl');
      expect(hits).toEqual([]);
      // Another loopback port still answers through curl.
      const plain = await t.services.tools.invoke({ capability: 'http.request', input: { method: 'GET', url: `http://127.0.0.1:${other.port}/ok`, shell: 'curl' }, origin: 'agent', scope: scope() });
      expect(plain.decision).toBe('allow');
      expect(plain.execution.providerId).toBe('curl');
      expect(plain.result.ok, plain.result.summary).toBe(true);
      expect(hits).toEqual(['/ok']);
    } finally {
      setSelfReferences({ dataDir: t.dataDir, port: 4317 });
      self.server.close();
      other.server.close();
    }
  }, 30_000);

  it('never reaches it under another name with a loopback Host header, sends a body as written, and asserts on the redacted body', async () => {
    const curl = await t.services.tools.check('curl');
    if (!curl.installed) return;
    const http = await import('node:http');
    const token = ['gh', 'p_', 'Z9y8X7w6'.repeat(4), 'Vv1U'].join('');
    const seen: Array<{ host: string; body: string }> = [];
    const listen = async () => {
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          seen.push({ host: req.headers.host ?? '', body });
          res.end(`hello ${token}`);
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return { server, port: (server.address() as { port: number }).port };
    };
    const self = await listen();
    const other = await listen();
    setSelfReferences({ dataDir: t.dataDir, port: self.port });
    const agent = (capability: string, input: Record<string, unknown>) => t.services.tools.invoke({ capability, input, origin: 'agent', scope: scope() });
    try {
      // lvh.me and *.nip.io resolve to this machine, and the Control Center answers any request whose Host is a loopback name.
      const renamed = { method: 'GET', url: `http://lvh.me:${self.port}/`, headers: { Host: 'localhost' }, shell: 'curl', expectText: 'acc-token' };
      expect((await agent('http.request', renamed)).decision).toBe('deny');
      expect((await agent('shell.run', { script: `curl -s -H 'Host: localhost' http://lvh.me:${self.port}/ | base64` })).decision).toBe('deny');
      const operator = await t.services.tools.invoke({ capability: 'http.request', input: renamed, origin: 'operator', scope: scope() });
      expect(operator.execution.providerId).toBe('curl');
      expect(operator.result.error?.code).toBe('DENIED');
      expect(seen).toEqual([]);

      // Another Host header, to another port, still goes out.
      const named = await agent('http.request', { method: 'GET', url: `http://127.0.0.1:${other.port}/`, headers: { Host: 'example.test' }, shell: 'curl' });
      expect(named.decision).toBe('allow');
      expect(named.result.ok, named.result.summary).toBe(true);
      expect(seen.at(-1)?.host).toBe('example.test');

      // A body starting with `@` is sent as written, never read from that file.
      const file = path.join(work, 'upload-me.txt');
      writeFileSync(file, 'file contents');
      const posted = await agent('http.request', { method: 'POST', url: `http://127.0.0.1:${other.port}/`, body: `@${file}`, shell: 'curl' });
      expect(posted.execution.providerId).toBe('curl');
      expect(posted.result.ok, posted.result.summary).toBe(true);
      expect(seen.at(-1)?.body).toBe(`@${file}`);

      // Nor can a header: a line break in one would start another curl option (`data-binary = @file` uploads the file).
      const before = seen.length;
      const injected = await agent('http.request', { method: 'GET', url: `http://127.0.0.1:${other.port}/`, headers: { 'X-Trace': `x\\"\ndata-binary = @${file}` }, shell: 'curl' });
      expect(injected.result.error?.code).toBe('INVALID_INPUT');
      expect(seen.length).toBe(before);

      // An expectation is judged on the body as shown: it cannot probe a secret the output hides.
      for (const shell of ['curl', undefined]) {
        const probe = await agent('http.request', { method: 'GET', url: `http://127.0.0.1:${other.port}/`, expectText: token.slice(0, 16), ...(shell ? { shell } : {}) });
        expect(probe.result.ok, `${shell}: ${probe.result.summary}`).toBe(false);
        expect(JSON.stringify(probe.result)).not.toContain(token);
        const plain = await agent('http.request', { method: 'GET', url: `http://127.0.0.1:${other.port}/`, expectText: 'hello', ...(shell ? { shell } : {}) });
        expect(plain.result.ok, `${shell}: ${plain.result.summary}`).toBe(true);
      }
    } finally {
      setSelfReferences({ dataDir: t.dataDir, port: 4317 });
      self.server.close();
      other.server.close();
    }
  }, 30_000);

  it('does not refuse an operator page whose path only names a self-reference word', async () => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => res.end('readme'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/octokit/auth-token.js`;
      const outcome = await t.services.tools.invoke({ capability: 'web.read', input: { url }, origin: 'operator', scope: scope() });
      expect(outcome.result.ok, outcome.result.summary).toBe(true);
      // An agent's input is still checked whole.
      expect((await t.services.tools.invoke({ capability: 'web.read', input: { url }, origin: 'agent', scope: scope() })).decision).toBe('deny');
    } finally {
      server.close();
    }
  });
});

describe('SEC-1: git.push is scanned for secrets and a push to the release branch is a deploy', () => {
  const run = async (cwd: string, args: string[]) => {
    const { git } = await import('@acc/git');
    const r = await git(cwd, args);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const remoteHas = async (remote: string, branch: string) => {
    const { git } = await import('@acc/git');
    return (await git(remote, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  };
  const release = (branch: string) => ({ method: 'push', remote: 'origin', branch, liveUrl: 'https://live.test/', proof: { versionUrl: 'https://live.test/version' }, manualPaths: [], timeoutSec: 60 });

  /** A repository with a bare `origin` it has pushed main to, registered with this release branch and the full policy. */
  async function pushRepo(releaseBranch: string | null) {
    const repo = await makeRepo();
    const remote = path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-remote-')), 'origin.git');
    await run(os.tmpdir(), ['init', '--bare', '-b', 'main', remote]);
    await run(repo, ['remote', 'add', 'origin', remote]);
    await run(repo, ['push', '-u', 'origin', 'main']);
    const repositoryId = await addRepoTo(t, repo, { policyMode: 'full', ...(releaseBranch ? { release: release(releaseBranch) } : {}) });
    const commit = async (branch: string, file: string, content: string) => {
      await run(repo, ['switch', '-C', branch]);
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), content);
      await run(repo, ['add', file]);
      await run(repo, ['commit', '-m', `change ${file}`]);
    };
    const call = (input: Record<string, unknown>, confirmation?: string) => t.api('POST', '/api/tools/call', { repositoryId, capability: 'git.push', input, ...(confirmation ? { confirmation } : {}) });
    return { repo, remote, repositoryId, commit, call };
  }

  it('needs a typed Level 5 approval to push main when main is the release branch, while a feature branch stays Level 3', async () => {
    const r = await pushRepo('main');
    await r.commit('main', 'notes.md', 'release notes\n');
    const asked = await r.call({ branch: 'main' });
    expect(asked.status).toBe(200);
    expect(asked.body.decision).toBe('approval');
    expect(asked.body.execution).toMatchObject({ status: 'needs_approval', permissionLevel: 5 });
    expect(asked.body.result.summary).toMatch(/release branch/);
    // Any other typed word is not the confirmation.
    expect((await r.call({ branch: 'main' }, 'yes')).body.decision).toBe('approval');
    expect(await run(r.remote, ['rev-parse', 'refs/heads/main'])).not.toBe(await run(r.repo, ['rev-parse', 'main']));

    // An agent is refused outright.
    const agent = await t.services.tools.invoke({ capability: 'git.push', input: { branch: 'main' }, origin: 'agent', scope: scope({ repositoryId: r.repositoryId, cwd: r.repo, roots: [r.repo] }) });
    expect(agent.decision).toBe('deny');

    const typed = await r.call({ branch: 'main' }, 'git.push');
    expect(typed.body.result.ok, typed.body.result.summary).toBe(true);
    expect(await run(r.remote, ['rev-parse', 'refs/heads/main'])).toBe(await run(r.repo, ['rev-parse', 'main']));

    await r.commit('feature/login', 'login.ts', 'export const login = true;\n');
    const feature = await r.call({ branch: 'feature/login' });
    expect(feature.body.decision).toBe('allow');
    expect(feature.body.execution.permissionLevel).toBe(3);
    expect(feature.body.result.ok, feature.body.result.summary).toBe(true);
    expect(await remoteHas(r.remote, 'feature/login')).toBe(true);
  }, 60_000);

  it('rates a push to the release branch through a shell like git.push, however it is spelled', async () => {
    const r = await pushRepo('site');
    await r.commit('site', 'index.html', '<h1>site</h1>\n');
    const tipBefore = await run(r.remote, ['rev-parse', 'refs/heads/main']);
    const agentScope = scope({ repositoryId: r.repositoryId, cwd: r.repo, roots: [r.repo], stageLevel: 3 });
    // A script the call's args complete: `npm run ship -- origin site` runs `git push origin site`.
    writeFileSync(path.join(r.repo, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node -e "0"', ship: 'git push' } }));
    for (const [capability, input] of [
      ['shell.run', { script: 'git push origin site' }],
      ['shell.run', { script: 'git push -u origin HEAD:site' }],
      ['shell.run', { script: 'git -C . push origin HEAD:refs/heads/site' }],
      ['shell.run', { script: 'git push origin topic:main' }],
      // No refspec: the branch checked out, which is the release branch.
      ['shell.run', { script: 'git push' }],
      ['process.exec', { command: 'git', args: ['push', 'origin', 'site'] }],
      ['terminal.send', { id: 'nope', input: 'git push origin site\n' }],
      // Spellings Git or the shell read differently from their words (review of SEC-1).
      ['shell.run', { script: 'git push -n --no-dry-run origin site' }],
      ['shell.run', { script: 'git push --al origin' }],
      ['shell.run', { script: 'git push origin \\\nsite' }],
      ['shell.run', { script: 'echo "git push origin site" | bash' }],
      ['shell.run', { script: 'git -c alias.p=push p origin site' }],
      ['shell.run', { script: 'c=push; git $c origin site' }],
      ['shell.run', { script: `git send-pack ${JSON.stringify(r.remote)} site` }],
      ['node.run_script', { script: 'ship', args: ['origin', 'site'] }],
    ] as const) {
      const agent = await t.services.tools.invoke({ capability, input, origin: 'agent', scope: agentScope });
      expect(agent.decision, `${capability} ${JSON.stringify(input)}`).toBe('deny');
      expect(agent.execution.permissionLevel).toBe(5);
    }
    expect(await remoteHas(r.remote, 'site')).toBe(false);
    expect(await run(r.remote, ['rev-parse', 'refs/heads/main'])).toBe(tipBefore);

    const shellCall = (script: string, confirmation?: string) => t.api('POST', '/api/tools/call', { repositoryId: r.repositoryId, capability: 'shell.run', input: { script }, ...(confirmation ? { confirmation } : {}) });
    const asked = await shellCall('git push origin site');
    expect(asked.body.decision).toBe('approval');
    expect(asked.body.execution).toMatchObject({ status: 'needs_approval', permissionLevel: 5 });
    expect(asked.body.result.summary).toMatch(/release branch/);
    const typed = await shellCall('git push origin site', 'shell.run');
    expect(typed.body.result.ok, typed.body.result.summary).toBe(true);
    expect(await remoteHas(r.remote, 'site')).toBe(true);

    // A feature branch still goes out at Level 3, for an agent too.
    await r.commit('feature/login', 'login.ts', 'export const login = true;\n');
    const feature = await t.services.tools.invoke({ capability: 'shell.run', input: { script: 'git push origin feature/login' }, origin: 'agent', scope: agentScope });
    expect(feature.decision).toBe('allow');
    expect(feature.execution.permissionLevel).toBe(3);
    expect(feature.result.ok, feature.result.summary).toBe(true);
    expect(await remoteHas(r.remote, 'feature/login')).toBe(true);
  }, 60_000);

  it('pushes the commit it checked and still sets the upstream', async () => {
    const r = await pushRepo(null);
    await r.commit('feature/upstream', 'a.ts', 'export const a = 1;\n');
    const pushed = await r.call({ branch: 'feature/upstream', setUpstream: true });
    expect(pushed.body.result.ok, pushed.body.result.summary).toBe(true);
    expect(await run(r.remote, ['rev-parse', 'refs/heads/feature/upstream'])).toBe(await run(r.repo, ['rev-parse', 'feature/upstream']));
    expect(await run(r.repo, ['rev-parse', '--abbrev-ref', 'feature/upstream@{upstream}'])).toBe('origin/feature/upstream');
  }, 60_000);

  it("treats the repository's own release branch as production, and the same name elsewhere as a feature branch", async () => {
    const released = await pushRepo('site');
    await released.commit('site', 'index.html', '<h1>site</h1>\n');
    expect((await released.call({ branch: 'site' })).body.execution.permissionLevel).toBe(5);
    const plain = await pushRepo(null);
    await plain.commit('site', 'index.html', '<h1>site</h1>\n');
    const pushed = await plain.call({ branch: 'site' });
    expect(pushed.body.execution.permissionLevel).toBe(3);
    expect(pushed.body.result.ok, pushed.body.result.summary).toBe(true);
  }, 60_000);

  it('fails a push whose commits hold a runtime-assembled token and names the rule', async () => {
    const r = await pushRepo('main');
    const token = ['gh', 'p_', 'Q7w8E9r0'.repeat(4), 'Tt5Y'].join('');
    await r.commit('feature/leak', 'src/config.ts', `export const token = '${token}';\n`);
    const refused = await r.call({ branch: 'feature/leak' });
    expect(refused.body.decision).toBe('allow');
    expect(refused.body.result.ok).toBe(false);
    expect(refused.body.result.error.code).toBe('DENIED');
    expect(refused.body.result.summary).toMatch(/src\/config\.ts contains what looks like a GitHub token/);
    expect(JSON.stringify(refused.body)).not.toContain(token);
    expect(await remoteHas(r.remote, 'feature/leak')).toBe(false);
    const row = t.services.toolStore.listExecutions({ capability: 'git.push', limit: 1 })[0];
    expect(row?.summary).toMatch(/GitHub token/);
    expect(row?.summary).not.toContain(token);
  }, 60_000);
});

describe('SEC-1: a line typed into a terminal is judged whole, with the release gate, when Enter arrives', () => {
  const release = (branch: string) => ({ release: { method: 'push', remote: 'origin', branch, liveUrl: 'https://live.test/', proof: { versionUrl: 'https://live.test/version' }, manualPaths: [], timeoutSec: 60 } });

  it("refuses an agent's push to the release branch split across sends, and one after a checkout typed earlier", async () => {
    const repositoryId = await addRepoTo(t, await makeRepo(), release('site'));
    const opened = await t.api('POST', '/api/terminals', { repositoryId });
    expect(opened.status).toBe(201);
    const id = opened.body.id as string;
    const host = t.services.terminals.host(null, 3, ['site']);
    try {
      // Each chunk alone is harmless; the line the shell would run is not.
      await host.send(id, 'git push origin si');
      await expect(host.send(id, 'te\r')).rejects.toThrow(/Refused to run this line.*release branch/);
      await expect(host.send(id, 'gh pr me')).resolves.toBeUndefined();
      await expect(host.send(id, 'rge 12\r')).rejects.toThrow(/Refused.*pull request/);
      // A feature branch still goes out at Level 3.
      await expect(host.send(id, 'git push origin feature/x\r')).resolves.toBeUndefined();
      // A branch checked out by an earlier line is where a later push of HEAD goes, run yet or not.
      await expect(host.send(id, 'git switch -c site\r')).resolves.toBeUndefined();
      await expect(host.send(id, 'git push\r')).rejects.toThrow(/Refused/);
      await expect(host.send(id, 'git push origin feature/x\r')).resolves.toBeUndefined();
    } finally {
      await t.api('DELETE', `/api/terminals/${id}`);
    }
  }, 60_000);

  it('judges a command continued over several lines as the shell runs it, and refuses bash history expansion', async () => {
    const { git } = await import('@acc/git');
    const repo = await makeRepo();
    expect((await git(repo, ['switch', '-c', 'feature/x'])).code).toBe(0);
    const repositoryId = await addRepoTo(t, repo, release('site'));
    const opened = await t.api('POST', '/api/terminals', { repositoryId });
    expect(opened.status).toBe(201);
    const id = opened.body.id as string;
    const host = t.services.terminals.host(null, 3, ['site']);
    try {
      // Each line alone pushes the feature branch checked out, or nothing; the command the shell runs pushes the release branch.
      await expect(host.send(id, 'git push \\\r')).resolves.toBeUndefined();
      await expect(host.send(id, 'origin site\r')).rejects.toThrow(/Refused to run this line.*release branch/);
      await expect(host.send(id, "echo '\r")).resolves.toBeUndefined();
      await expect(host.send(id, "' ; git push origin site\r")).rejects.toThrow(/Refused.*release branch/);
      await expect(host.send(id, 'git push --dry-run origin site \\\r')).resolves.toBeUndefined();
      await expect(host.send(id, '--no-dry-run\r')).rejects.toThrow(/Refused.*release branch/);
      // Bash rewrites `!^` from its history after the line is judged (PowerShell, the default on Windows, does not).
      if (/bash|wsl/.test(opened.body.shell as string)) {
        await expect(host.send(id, 'echo site\r')).resolves.toBeUndefined();
        await expect(host.send(id, 'git push origin !^\r')).rejects.toThrow(/history expansion/);
        await expect(host.send(id, '^feature/x^site\r')).rejects.toThrow(/history expansion/);
      }
      // A quote closed on a later line, a feature push, and a `!` bash leaves alone still run.
      await expect(host.send(id, "echo 'a\r")).resolves.toBeUndefined();
      await expect(host.send(id, "b'\r")).resolves.toBeUndefined();
      await expect(host.send(id, 'git push --dry-run origin feature/x\r')).resolves.toBeUndefined();
      await expect(host.send(id, 'echo "done!"\r')).resolves.toBeUndefined();
      await expect(host.send(id, 'if ! true; then echo no; fi\r')).resolves.toBeUndefined();
    } finally {
      await t.api('DELETE', `/api/terminals/${id}`);
    }
  }, 60_000);

  it('refuses the same from the cloud, split across messages', () => {
    const writes: string[] = [];
    const port = { write: (_id: string, d: string) => void writes.push(d), resize: () => undefined, close: async () => undefined };
    const g = new TerminalGrants(port, () => 3, { idleMs: 60_000, maxMs: 60_000 }, Date.now, () => undefined, (terminalId, line, before) => t.services.terminals.judgeLine(terminalId, line, ['site'], before));
    g.grant('t1');
    expect(g.input('t1', 'git push origin si').refused).toEqual([]);
    expect(g.input('t1', 'te\r').refused).toEqual(['git push origin site']);
    expect(g.input('t1', 'git push origin feature/x\r').refused).toEqual([]);
    expect(g.input('t1', 'git switch site\r').refused).toEqual([]);
    expect(g.input('t1', 'git push\r').refused).toEqual(['git push']);
    expect(g.input('t1', 'gh pr merge 3\r').refused).toEqual(['gh pr merge 3']);
    // A command continued over lines is judged whole, and a line bash would rewrite from its history is refused.
    expect(g.input('t1', "echo '\r").refused).toEqual([]);
    expect(g.input('t1', "' ; git push origin site\r").refused).toEqual(["' ; git push origin site"]);
    expect(g.input('t1', 'git push --dry-run origin site \\\r').refused).toEqual([]);
    expect(g.input('t1', '--no-dry-run\r').refused).toEqual(['--no-dry-run']);
    expect(g.input('t1', 'git push origin !^\r').refused).toEqual(['git push origin !^']);
    expect(g.input('t1', "echo 'a\rb'\rgit push origin feature/x\r").refused).toEqual([]);
    void g.revokeAll();
  });
});

describe('SEC-1: in a multi-repository task every repository\'s release branch counts', () => {
  it('rates a push to another repository of the task from inside one of them as a deploy', async () => {
    const release = (remote: string, branch: string) => ({ release: { method: 'push', remote, branch, liveUrl: 'https://live.test/', proof: { versionUrl: 'https://live.test/version' }, manualPaths: [], timeoutSec: 60 } });
    const a = await makeRepo();
    const b = await makeRepo();
    const aId = await addRepoTo(t, a, release('origin', 'site'));
    const bId = await addRepoTo(t, b, release('upstream', 'www'));
    const inA = scope({ repositoryId: aId, repositories: [{ id: aId, root: a }, { id: bId, root: b }], cwd: a, roots: [a, b], stageLevel: 3 });
    for (const script of [`git -C ${JSON.stringify(b)} push upstream www`, 'git push upstream www', 'git push origin site']) {
      const outcome = await t.services.tools.invoke({ capability: 'shell.run', input: { script }, origin: 'agent', scope: inA });
      expect(outcome.decision, script).toBe('deny');
      expect(outcome.execution.permissionLevel).toBe(5);
    }
    const feature = await t.services.tools.invoke({ capability: 'shell.run', input: { script: 'git push --dry-run upstream feature/x' }, origin: 'agent', scope: inA });
    expect(feature.decision).toBe('allow');
  }, 60_000);
});

describe('SEC-1: a command a stage runs is judged with the release gate', () => {
  it('holds a build script that pushes to the release branch for a typed approval, and rates a feature push as before', async () => {
    const release = { release: { method: 'push', remote: 'origin', branch: 'site', liveUrl: 'https://live.test/', proof: { versionUrl: 'https://live.test/version' }, manualPaths: [], timeoutSec: 60 } };
    // An agent can edit the scripts a later stage runs.
    const repoPath = await makeRepo({ scripts: { test: 'node -e "0"', build: 'node -e "0" && git push origin site' } });
    expect(stageCommandRisk(repoPath, 'npm run build', ['site'])).toMatchObject({ level: 5, production: true });
    expect(stageCommandRisk(repoPath, 'npm run build', [])).toMatchObject({ level: 3, production: false });
    expect(stageCommandRisk(repoPath, 'git push origin feature/x', ['site'])).toMatchObject({ level: 3, production: false });
    expect(stageCommandRisk(repoPath, 'npm test', ['site'])).toMatchObject({ production: false });
    const id = await createTask(t, await addRepoTo(t, repoPath, release), 'Ship through the build');
    const task = await waitForStatus(t, id, ['WAITING_FOR_USER', 'COMPLETED', 'FAILED'], 60_000);
    expect(task.status).toBe('WAITING_FOR_USER');
    const pending = (await t.api('GET', '/api/approvals?status=pending')).body.filter((a: { taskId: string }) => a.taskId === id);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'command', permissionLevel: 5, environment: 'production' });
    expect(pending[0].reason).toMatch(/release branch/);
    await t.api('POST', `/api/tasks/${id}/cancel`);
  }, 90_000);
});

describe("SEC-1: a stage agent is told where a push deploys, so its native shell can deny it", () => {
  class RecordingAdapter extends SimulatedAgentAdapter {
    readonly inputs: AgentExecutionInput[] = [];
    override execute(input: AgentExecutionInput): Promise<AgentExecutionHandle> {
      this.inputs.push(input);
      return super.execute(input);
    }
  }

  it('passes the release branches with every agent run of a releasing task, every repository of it, and nothing otherwise', async () => {
    SimulatedAgentAdapter.reset();
    const claude = new RecordingAdapter('claude', 'Claude Code (simulated)', 5);
    const codex = new RecordingAdapter('codex', 'Codex (simulated)', 5);
    const app = await createTestApp({ adapters: [codex, claude] });
    try {
      const release = (remote: string, branch: string) => ({ method: 'push', remote, branch, liveUrl: 'https://live.test/', proof: { versionUrl: 'https://live.test/version' }, manualPaths: [], timeoutSec: 60 });
      const releasing = await addRepoTo(app, await makeRepo(), { release: release('origin', 'site') });
      const docs = await addRepoTo(app, await makeRepo(), { release: release('upstream', 'www') });
      const plain = await addRepoTo(app, await makeRepo());
      const runsOf = (taskId: string) => [...claude.inputs, ...codex.inputs].filter((r) => r.prompt.includes(taskId));
      const site = await createTask(app, releasing, 'Change the README of the site');
      const other = await createTask(app, plain, 'Change the README');
      const both = await createTask(app, plain, 'Change the README in both repositories', { linkedRepositoryIds: [docs], workflowId: 'quick-change', supervised: false });
      await waitFor(() => [runsOf(site).length, runsOf(other).length, runsOf(both).length], (counts) => counts.every((n) => n > 0), 30_000, 'agent runs of every task');
      expect(runsOf(site).every((r) => JSON.stringify(r.releaseBranches) === JSON.stringify([{ remote: 'origin', branch: 'site' }]))).toBe(true);
      expect(runsOf(other).every((r) => r.releaseBranches === undefined)).toBe(true);
      // A linked repository's release counts too: its folder is in the same workspace.
      expect(runsOf(both).every((r) => JSON.stringify(r.releaseBranches) === JSON.stringify([{ remote: 'upstream', branch: 'www' }]))).toBe(true);
    } finally {
      await app.close();
    }
  }, 60_000);
});
