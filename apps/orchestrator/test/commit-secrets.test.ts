import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import { git } from '@acc/git';
import { detectSecrets } from '@acc/security';
import { installFakeScanners, type FakeAdvisory } from '../../../packages/tools/test/fixtures/fake-scanners.js';
import { addRepo, createTask, createTestApp, IN_PLACE, makeRepo, waitFor, waitForStatus, type TestApp } from './helpers.js';

/**
 * VER-1 end to end with the simulated agents: a task whose implementer writes
 * a GitHub-token-shaped string into a source file ([sim:writes-token], the
 * token assembled at run time) ends with no commit holding it at each commit
 * site — the Git checkpoint (the fixer takes the token out and the checkpoint
 * then passes), a worktree's final commit (the files stay in the backup ref,
 * with an event) and the git.commit tool (a failure). A task that adds a
 * dependency with a known advisory shows the reviewer that advisory and not
 * the one its baseline lockfile already had; the dependency audit runs
 * against a stand-in osv-scanner, never the network.
 */

let t: TestApp;

afterEach(async () => {
  await t.close();
});

const read = (id: string, name: string) => readFileSync(path.join(t.dataDir, 'tasks', id, name), 'utf8');
const events = (id: string) => t.services.store.listEvents(id, { limit: 2000 });

/** Everything a branch's history adds, checked with the same detector the commit check uses. */
async function secretsOnBranch(repoPath: string, branch: string): Promise<string[]> {
  const log = await git(repoPath, ['log', '-p', '--format=%H', branch]);
  expect(log.code).toBe(0);
  return detectSecrets(log.stdout);
}

describe('the secret check at every commit of task work', () => {
  beforeEach(async () => {
    SimulatedAgentAdapter.reset();
    t = await createTestApp();
  });

  it('fails the Git checkpoint, the fixer removes the token, then the checkpoint commits it clean', async () => {
    const repoPath = await makeRepo({ scripts: { test: 'node -e "0"' } });
    const id = await createTask(t, await addRepo(t, repoPath, IN_PLACE), 'Configure the client [sim:writes-token]', { workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(done.status).toBe('COMPLETED');
    const keys = t.services.store.listStages(id).map((s) => `${s.stageKey}:${s.status}`);
    expect(keys).toEqual(expect.arrayContaining(['git:FAILED', 'fix:SUCCESS', 'git:SUCCESS']));
    expect(keys.indexOf('git:FAILED')).toBeLessThan(keys.indexOf('fix:SUCCESS'));
    expect(keys.indexOf('fix:SUCCESS')).toBeLessThan(keys.indexOf('git:SUCCESS'));
    const refused = t.services.store.listStages(id).find((s) => s.stageKey === 'git' && s.status === 'FAILED')!;
    expect(refused.errorMessage).toContain('Secret check refused the commit: sim-config.ts contains what looks like a GitHub token');
    expect(events(id).some((e) => e.type === 'STAGE_FAILED' && e.message.startsWith('Git checkpoint was refused by the secret check'))).toBe(true);
    // The fixer was told what the check found, as it is told a rejected hook.
    const fixPrompt = read(id, 'fix-prompt.md');
    expect(fixPrompt).toContain("Git checkpoint was refused by the Control Center's secret check:");
    expect(fixPrompt).toContain('sim-config.ts contains what looks like a GitHub token');
    // The reviewers saw the scan before any commit was tried, and the report counts it as evidence.
    const reviewPrompt = t.services.store.listArtifacts(id).find((a) => a.name.startsWith('review-prompt'))!.name;
    expect(read(id, reviewPrompt)).toContain('- Secret scan: 1 file(s) hold secret material; no commit of this task takes them until it is removed:\n  - sim-config.ts contains what looks like a GitHub token');
    expect(read(id, 'final-report.md')).toMatch(/^- Verified: .*Security scan/m);
    // The one commit is the fixed file: no commit on the branch holds the token.
    expect(done.git.commits).toHaveLength(1);
    expect((await git(repoPath, ['show', '--name-only', '--format=', done.git.commits[0]!])).stdout.split('\n').sort()).toEqual(['sim-config.ts', 'sim-output.md']);
    expect(await secretsOnBranch(repoPath, done.git.taskBranch!)).toEqual([]);
  }, 120_000);

  it('keeps a worktree task\'s files out of the branch at its final commit: backup ref, an event and a report that is not ready', async () => {
    const repoPath = await makeRepo();
    const id = await createTask(t, await addRepo(t, repoPath), 'Configure the client [sim:writes-token]');
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(done.status).toBe('COMPLETED');
    expect(done.git.isolated).toBe(true);
    expect(done.git.commits).toEqual([]);
    const blocked = events(id).filter((e) => e.type === 'SECRET_BLOCKED');
    expect(blocked).toHaveLength(1);
    const ref = `refs/acc/worktree-backup/${id}`;
    expect(blocked[0]!.message).toContain(`The secret check kept 2 file(s) off ${done.git.taskBranch}. sim-config.ts contains what looks like a GitHub token. They are kept in ${ref}`);
    expect(blocked[0]!.data).toMatchObject({ ref, findings: [{ path: 'sim-config.ts', reason: 'contains what looks like a GitHub token' }] });
    // The files are kept in the backup ref, off the branch, and the worktree is gone.
    const kept = await git(repoPath, ['ls-tree', '-r', '--name-only', ref]);
    expect(kept.stdout.split('\n')).toEqual(expect.arrayContaining(['sim-config.ts', 'sim-output.md']));
    expect(done.git.worktreePath).toBeNull();
    // The removal says where the files are, and never to merge the branch for them.
    const removed = events(id).filter((e) => e.type === 'WORKTREE_REMOVED');
    expect(removed.map((e) => e.message)).toEqual([`Worktree removed; the files the secret check refused are in ${ref}, not on branch ${done.git.taskBranch}`]);
    expect(await secretsOnBranch(repoPath, done.git.taskBranch!)).toEqual([]);
    expect(done.finalStatus).not.toBe('READY');
    expect(read(id, 'final-report.md')).toContain('sim-config.ts contains what looks like a GitHub token');
  }, 120_000);

  it('makes the git.commit tool an agent calls fail, committing nothing', async () => {
    // The tool route must be reachable over HTTP, as it is for a real agent's MCP bridge.
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    t.services.tooling.setListenUrl(address);
    (t.services.tooling as unknown as { d: { bridgePath: string } }).d.bridgePath = 'acc-mcp.js';
    t.services.workflows.save('tool-commit', {
      name: 'Tool commit',
      maxFixCycles: 0,
      stages: [{ key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 3, next: 'complete' }],
    });
    const repoPath = await makeRepo();
    const head = (await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim();
    const id = await createTask(t, await addRepo(t, repoPath, IN_PLACE), 'Configure the client [sim:writes-token] [sim:tool-commit]', { workflowId: 'tool-commit' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.status).toBe('COMPLETED');
    const [commit] = t.services.toolStore.listExecutions({ taskId: id, capability: 'git.commit' });
    expect(commit).toMatchObject({ origin: 'agent', status: 'failed', errorCode: 'DENIED' });
    expect(commit!.summary).toContain('Secret check refused the commit: sim-config.ts contains what looks like a GitHub token');
    expect(read(id, 'implementation-report.md')).toContain('- git.commit: REFUSED Secret check refused the commit');
    expect((await git(repoPath, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(head);
    expect((await git(repoPath, ['diff', '--cached', '--name-only'])).stdout).toBe('');
    expect(await secretsOnBranch(repoPath, done.git.taskBranch!)).toEqual([]);
  }, 90_000);
});

describe('the dependency audit in the review prompt', () => {
  const DB: FakeAdvisory[] = [
    { package: 'old-vulnerable', version: '2.0.0', id: 'GHSA-oldd-0000-aaaa', severity: 'MODERATE', fixed: '2.0.5', summary: 'Already there before the task' },
    { package: 'sim-vulnerable', version: '1.0.0', id: 'GHSA-simv-1111-bbbb', severity: 'HIGH', fixed: '1.0.1', summary: 'Prototype pollution in sim-vulnerable' },
  ];

  beforeEach(async () => {
    SimulatedAgentAdapter.reset();
    const bin = installFakeScanners(['osv-scanner'], DB);
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    t = await createTestApp({ baseEnv: { ...process.env, [key]: `${bin}${path.delimiter}${process.env[key] ?? ''}` } });
  });

  it('lists the advisory the change brings in, with severity and fixed-in version, and not the baseline\'s own', async () => {
    const repoPath = await makeRepo({ files: { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\npackages:\n\n  old-vulnerable@2.0.0:\n    resolution: {tarball: old-vulnerable-2.0.0.tgz}\n" } });
    const repoId = await addRepo(t, repoPath, IN_PLACE);
    // The checks run with node, whatever package manager the lockfile names.
    const patched = await t.api('PATCH', `/api/repositories/${repoId}`, { commands: [{ id: 'test', name: 'unit tests', command: 'node -e "console.log(\'1 passed\')"', kind: 'test', enabled: true, timeoutSec: 60 }] });
    expect(patched.status).toBe(200);
    const id = await createTask(t, repoId, 'Add the helper library [sim:adds-dependency]');
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(done.status).toBe('COMPLETED');
    for (const prompt of ['review-prompt.md', 'verification-prompt.md']) {
      const text = read(id, prompt);
      expect(text, prompt).toContain('## Security scans (run by the orchestrator on this change)');
      expect(text, prompt).toContain('- Dependency audit (osv-scanner): 1 advisory this change brings in, not on the baseline lockfile:');
      expect(text, prompt).toContain('  - GHSA-simv-1111-bbbb · sim-vulnerable 1.0.0 · severity HIGH · fixed in 1.0.1 — Prototype pollution in sim-vulnerable (pnpm-lock.yaml)');
      expect(text, prompt).toContain('1 advisory was already on the baseline lockfile and is not listed.');
      expect(text, prompt).not.toContain('GHSA-oldd-0000-aaaa');
    }
    const audits = t.services.toolStore.listExecutions({ taskId: id, capability: 'security.dependency_audit' });
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((e) => e.origin === 'engine' && e.status === 'succeeded')).toBe(true);
    expect(read(id, 'final-report.md')).toMatch(/^- Verified: .*Security scan/m);
  }, 120_000);

  it('counts a security scan that ran as "Security scan" evidence, and an unverified audit as none', async () => {
    const repoId = await addRepo(t, await makeRepo(), IN_PLACE);
    const id = await createTask(t, repoId, 'Look [sim:slow]');
    const task = t.services.store.getTask(id)!;
    const repo = t.services.store.getRepository(repoId)!;
    const now = new Date().toISOString();
    const row = (capability: string, status: 'succeeded' | 'failed') =>
      t.services.toolStore.insertExecution({ id: `x-${capability}-${status}`, taskId: id, stageId: null, sessionId: null, capability, providerId: 'security', origin: 'engine', routeReason: null, inputSummary: '{}', attempt: 1, recoveryOf: null, artifacts: [], filesChanged: [], networkTargets: [], evidence: [], startedAt: now, finishedAt: now, durationMs: 1, status, decision: 'allow', permissionLevel: 1, risk: 'normal', effects: [], summary: 'x', errorCode: status === 'failed' ? 'UNAVAILABLE' : null });
    row('security.dependency_audit', 'failed');
    expect(t.services.tooling.verificationCoverage(task, repo, [], []).satisfied).not.toContain('Security scan');
    row('security.secret_scan', 'succeeded');
    expect(t.services.tooling.verificationCoverage(task, repo, [], []).satisfied).toContain('Security scan');
    await t.api('POST', `/api/tasks/${id}/cancel`);
  });

  it('names a changed lockfile no scanner could read as unverified, never as bringing in no new advisory', async () => {
    // Without osv-scanner only pnpm-lock.yaml has an audit (pnpm's own); Cargo.lock has none.
    await t.close();
    const bin = installFakeScanners(['pnpm'], DB);
    const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const noOsv = (process.env[key] ?? '').split(path.delimiter).filter((dir) => !['osv-scanner', 'osv-scanner.exe', 'osv-scanner.cmd'].some((n) => existsSync(path.join(dir, n))));
    t = await createTestApp({ baseEnv: { ...process.env, [key]: [bin, ...noOsv].join(path.delimiter) } });
    const repoPath = await makeRepo({ files: { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\npackages:\n\n  old-vulnerable@2.0.0:\n    resolution: {tarball: old-vulnerable-2.0.0.tgz}\n", 'Cargo.lock': 'version = 3\n' } });
    const repoId = await addRepo(t, repoPath, IN_PLACE);
    const id = await createTask(t, repoId, 'Add a crate and a helper [sim:hang]', { workflowId: 'quick-change', supervised: false });
    const task = await waitFor(() => t.services.store.getTask(id)!, (x) => Boolean(x.git.baselineSnapshotId), 30_000, 'the baseline');
    const stage = await waitFor(() => t.services.store.listStages(id)[0], (s) => Boolean(s), 30_000, 'a stage');
    const repo = t.services.store.getRepository(repoId)!;
    const memo = (t.services.tooling as unknown as { securityMemo: Map<string, unknown> }).securityMemo;
    // Both lockfiles change; nothing pnpm reads is vulnerable.
    appendFileSync(path.join(repoPath, 'pnpm-lock.yaml'), '\n  harmless@1.0.0:\n    resolution: {tarball: harmless-1.0.0.tgz}\n');
    appendFileSync(path.join(repoPath, 'Cargo.lock'), '\n[[package]]\nname = "sim-crate"\nversion = "1.0.0"\n');
    const clean = await t.services.tooling.securityFindings(task, repo, stage!);
    expect(clean).toContain('- Dependency audit (pnpm audit): the change brings in no new advisory (pnpm-lock.yaml).');
    expect(clean).toContain('- Dependency audit (Cargo.lock): unverified — osv-scanner is not installed');
    expect(clean).not.toMatch(/no new advisory \([^)]*Cargo\.lock/);
    // A new advisory in the one lockfile that was audited leaves the other unverified too.
    appendFileSync(path.join(repoPath, 'pnpm-lock.yaml'), '\n  sim-vulnerable@1.0.0:\n    resolution: {tarball: sim-vulnerable-1.0.0.tgz}\n');
    memo.clear();
    const fresh = await t.services.tooling.securityFindings(task, repo, stage!);
    expect(fresh).toContain('- Dependency audit (pnpm audit): 1 advisory this change brings in, not on the baseline lockfile:\n  - GHSA-simv-1111-bbbb');
    expect(fresh).toContain('- Dependency audit (Cargo.lock): unverified — osv-scanner is not installed');
    const [audit] = t.services.toolStore.listExecutions({ taskId: id, capability: 'security.dependency_audit' });
    expect(audit!.summary).toContain('Not audited: Cargo.lock (osv-scanner is not installed)');
    await t.api('POST', `/api/tasks/${id}/cancel`);
  }, 120_000);

  it("runs no audit when no lockfile changed, and never reports your own pre-existing work as the task's secret", async () => {
    // Your own uncommitted file holding a token when the task starts is not the task's change.
    const mine = ['gh', 'p_', 'Us3rW0rk'.repeat(4), 'Mm1N'].join('');
    const repoPath = await makeRepo({ dirty: { 'notes.txt': `mine: ${mine}\n` } });
    const id = await createTask(t, await addRepo(t, repoPath, IN_PLACE), 'Change the output');
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 90_000);
    expect(done.status).toBe('COMPLETED');
    expect(read(id, 'review-prompt.md')).toContain('- Dependency audit: no lockfile changed since the baseline, so the change brings in no new advisory.');
    expect(read(id, 'review-prompt.md')).toContain('- Secret scan: no secret material in the 1 file(s) this task changed.');
    expect(read(id, 'review-prompt.md')).not.toContain('notes.txt contains');
    expect(t.services.toolStore.listExecutions({ taskId: id, capability: 'security.dependency_audit' })).toEqual([]);
  }, 120_000);
});
