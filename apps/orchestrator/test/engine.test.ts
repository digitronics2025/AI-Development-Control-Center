import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import { currentBranch, git } from '@acc/git';
import { addRepo, createTask, createTestApp, makeRepo, simAdapters, waitFor, waitForStatus, type TestApp } from './helpers.js';

let t: TestApp;

beforeEach(async () => {
  SimulatedAgentAdapter.reset();
  t = await createTestApp();
});

afterEach(async () => {
  await t.close();
});

const artifactNames = (id: string) => t.services.store.listArtifacts(id).map((a) => a.name);
const eventTypes = (id: string) => t.services.store.listEvents(id, { limit: 2000 }).map((e) => e.type);

describe('normal development workflow', () => {
  it('runs every stage end to end on autopilot and produces a verified report', async () => {
    const repoPath = await makeRepo({ scripts: { lint: 'node -e "0"', test: 'node -e "console.log(\'5 passed\')"', build: 'node -e "0"' } });
    const repoId = await addRepo(t, repoPath);
    const id = await createTask(t, repoId, 'Add a greeting to the output file');
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);

    expect(task.status).toBe('COMPLETED');
    expect(task.finalStatus).toBe('READY');
    const stages = t.services.store.listStages(id);
    expect(stages.map((s) => `${s.stageKey}:${s.status}`)).toEqual([
      'investigate:SUCCESS',
      'plan:SUCCESS',
      'implement:SUCCESS',
      'test:SUCCESS',
      'review:SUCCESS',
      'verify:SUCCESS',
    ]);
    // Role defaults: Codex investigates/plans/reviews, Claude implements.
    expect(stages.find((s) => s.stageKey === 'investigate')?.agentId).toBe('codex');
    expect(stages.find((s) => s.stageKey === 'implement')?.agentId).toBe('claude');
    expect(artifactNames(id)).toEqual(
      expect.arrayContaining(['request.md', 'investigation.md', 'plan.md', 'implementation-prompt.md', 'implementation-report.md', 'tests.log', 'review.md', 'verification.md', 'git-diff.patch', 'final-report.md', 'task.json']),
    );
    expect(t.services.store.listTestRuns(id).map((r) => `${r.name}:${r.status}`)).toEqual(['lint:passed', 'unit tests:passed', 'build:passed']);
    expect(task.git.taskBranch).toMatch(/^ai\/TASK-0001-add-a-greeting/);
    expect(await currentBranch(repoPath)).toBe(task.git.taskBranch);
    expect(eventTypes(id)).toEqual(expect.arrayContaining(['TASK_CREATED', 'TASK_STARTED', 'GIT_BASELINE', 'GIT_BRANCH', 'STAGE_STARTED', 'AGENT_STARTED', 'TEST_PASSED', 'REVIEW_PASSED', 'TASK_COMPLETED']));

    const changes = await t.api('GET', `/api/tasks/${id}/changes`);
    expect(changes.body.files).toEqual([expect.objectContaining({ path: 'sim-output.md', origin: 'task', status: 'untracked' })]);
    const report = readFileSync(path.join(t.dataDir, 'tasks', id, 'final-report.md'), 'utf8');
    expect(report).toContain('TASK COMPLETED');
    expect(report).toContain('3 passed · 0 failed · 0 not run');
    expect(report).toContain('READY');
    // Every prompt tells the agent it is a subagent whose reply is a task record, not a chat answer.
    const prompt = readFileSync(path.join(t.dataDir, 'tasks', id, 'implementation-prompt.md'), 'utf8');
    expect(prompt).toContain('You are running as a subagent of the AI Development Control Center');
  });

  it('reports operator decisions named by the verifier instead of calling the task ready', async () => {
    const repoId = await addRepo(t, await makeRepo());
    const id = await createTask(t, repoId, 'Check the service end to end [sim:needs-operator]');
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    expect(task.status).toBe('COMPLETED');
    expect(task.fixCycles).toBe(0);
    expect(task.finalStatus).toBe('NEEDS_USER_ACTION');
    const report = readFileSync(path.join(t.dataDir, 'tasks', id, 'final-report.md'), 'utf8');
    expect(report).toContain('- Needs your decision: Choose whether the service listens on the network.');
  });

  it('says so when a task starts on another task\'s unmerged branch', async () => {
    const repoPath = await makeRepo();
    await git(repoPath, ['switch', '-c', 'ai/TASK-0042-earlier-work']);
    const id = await createTask(t, await addRepo(t, repoPath), 'Build on it');
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    const events = t.services.store.listEvents(id, { limit: 2000 }).map((e) => e.message);
    expect(events).toContainEqual(expect.stringContaining("Started from TASK-0042's branch ai/TASK-0042-earlier-work"));
    const report = readFileSync(path.join(t.dataDir, 'tasks', id, 'final-report.md'), 'utf8');
    expect(report).toContain("(TASK-0042's branch — merge TASK-0042 first)");
  });

  it('protects pre-existing uncommitted work and reports it separately', async () => {
    const repoPath = await makeRepo({ dirty: { 'README.md': '# Test repo\nuser edit in progress\n', 'notes.txt': 'mine\n' } });
    const id = await createTask(t, await addRepo(t, repoPath), 'Change something');
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    expect(task.status).toBe('COMPLETED');
    expect(task.git.preexistingChanges.sort()).toEqual(['README.md', 'notes.txt']);
    expect(readFileSync(path.join(repoPath, 'README.md'), 'utf8')).toBe('# Test repo\nuser edit in progress\n');
    const changes = await t.api('GET', `/api/tasks/${id}/changes`);
    const origins = Object.fromEntries(changes.body.files.map((f: { path: string; origin: string }) => [f.path, f.origin]));
    expect(origins).toMatchObject({ 'README.md': 'preexisting', 'notes.txt': 'preexisting', 'sim-output.md': 'task' });
    expect(changes.body.preexistingWarning).toBe(true);
    expect(changes.body.totals.files).toBe(1);
  });
});

describe('discuss first', () => {
  it('stops after planning for plan review, then continues on approval', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Refactor the thing', { mode: 'discuss' });
    const waiting = await waitForStatus(t, id, ['WAITING_FOR_USER', 'COMPLETED']);
    expect(waiting.status).toBe('WAITING_FOR_USER');
    expect(waiting.blocker?.kind).toBe('approval');
    expect(t.services.store.listStages(id).map((s) => s.stageKey)).toEqual(['investigate', 'plan']);
    const approvals = await t.api('GET', '/api/approvals');
    expect(approvals.body).toHaveLength(1);
    expect(approvals.body[0]).toMatchObject({ kind: 'plan_review', taskId: id, confirmationPhrase: null, action: 'Approve plan and start implementation' });

    const approved = await t.api('POST', `/api/approvals/${approvals.body[0].id}/approve`, {});
    expect(approved.status).toBe(200);
    expect((await waitForStatus(t, id, ['COMPLETED', 'FAILED'])).status).toBe('COMPLETED');
  });

  it('sends the plan back with feedback as a directive when changes are requested', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Refactor the thing', { mode: 'discuss' });
    await waitForStatus(t, id, ['WAITING_FOR_USER']);
    const [approval] = (await t.api('GET', '/api/approvals')).body;
    await t.api('POST', `/api/approvals/${approval.id}/deny`, { note: 'Keep the public API unchanged' });
    await waitFor(
      () => t.services.store.listStages(id).filter((s) => s.stageKey === 'plan').length,
      (n) => n === 2,
      20_000,
      'second plan',
    );
    const directives = t.services.store.listDirectives(id);
    expect(directives[0]?.text).toBe('Plan feedback: Keep the public API unchanged');
    const task = await waitForStatus(t, id, ['WAITING_FOR_USER']);
    expect(task.blocker?.kind).toBe('approval');
    expect(directives[0]).toBeDefined();
    expect(t.services.store.listDirectives(id)[0]?.status).toBe('applied');
  });
});

// Tests below that pass `supervised: false` pin the unsupervised behaviour;
// the Chairman's handling of the same situations is in chairman.test.ts.
describe('review and fix loop', () => {
  it('runs a fix cycle when review fails once', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Fix it [sim:review-fail-once]');
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    expect(task.status).toBe('COMPLETED');
    expect(task.fixCycles).toBe(1);
    expect(t.services.store.listStages(id).map((s) => s.stageKey)).toEqual(['investigate', 'plan', 'implement', 'test', 'review', 'fix', 'test', 'review', 'verify']);
    expect(eventTypes(id)).toContain('FIX_CYCLE');
    expect(artifactNames(id)).toContain('fix-report.md');
  });

  it('stops at the fix limit instead of looping forever, and resume grants one more cycle', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Never good enough [sim:review-fail-always]', { maxFixCycles: 2, supervised: false });
    const task = await waitForStatus(t, id, ['WAITING_FOR_USER', 'COMPLETED', 'FAILED']);
    expect(task.status).toBe('WAITING_FOR_USER');
    expect(task.blocker?.kind).toBe('fix_limit');
    expect(task.fixCycles).toBe(2);
    expect(t.services.store.listStages(id).filter((s) => s.stageKey === 'fix')).toHaveLength(2);

    expect((await t.api('POST', `/api/tasks/${id}/resume`)).status).toBe(200);
    const again = await waitFor(
      () => t.services.store.getTask(id)!,
      (x) => x.status === 'WAITING_FOR_USER' && x.fixCycles === 3,
      20_000,
    );
    expect(again.blocker?.kind).toBe('fix_limit');
    expect(t.services.store.listStages(id).filter((s) => s.stageKey === 'fix')).toHaveLength(3);
  });

  it('routes failing tests to the fixer and records later commands as not run', async () => {
    const repoPath = await makeRepo({ scripts: { lint: 'node -e "0"', test: 'node -e "console.log(\'2 failed, 3 passed\'); process.exit(1)"', build: 'node -e "0"' } });
    const id = await createTask(t, await addRepo(t, repoPath), 'Break the tests', { maxFixCycles: 1, supervised: false });
    const task = await waitForStatus(t, id, ['WAITING_FOR_USER', 'COMPLETED', 'FAILED']);
    expect(task.status).toBe('WAITING_FOR_USER');
    expect(task.blocker?.kind).toBe('fix_limit');
    const runs = t.services.store.listTestRuns(id);
    const firstStage = runs[0]!.stageId;
    expect(runs.filter((r) => r.stageId === firstStage).map((r) => `${r.name}:${r.status}`)).toEqual(['lint:passed', 'unit tests:failed', 'build:not_run']);
    expect(runs.find((r) => r.status === 'failed')?.summary).toBe('2 failed, 3 passed');
    // A failed test run never produces a completed task.
    expect(task.finalStatus).toBeNull();
  });
});

describe('failure handling', () => {
  it('waits for a usage reset without any fallback, then resumes', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Big job [sim:usage-limit]', { supervised: false });
    const task = await waitForStatus(t, id, ['WAITING_FOR_USAGE_RESET', 'COMPLETED', 'FAILED']);
    expect(task.status).toBe('WAITING_FOR_USAGE_RESET');
    expect(task.blocker).toMatchObject({ kind: 'usage', errorClass: 'USAGE_LIMIT' });
    expect(task.blocker?.message).toContain('no paid API fallback');
    const implement = t.services.store.latestStage(id, 'implement')!;
    expect(implement.status).toBe('PAUSED');
    expect(implement.agentId).toBe('claude');

    await t.api('POST', `/api/tasks/${id}/resume`);
    expect((await waitForStatus(t, id, ['COMPLETED', 'FAILED'])).status).toBe('COMPLETED');
  });

  it('retries a crashing stage per its retry policy, then fails with a concrete next action', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Crash [sim:fail:investigator]', { supervised: false });
    const task = await waitForStatus(t, id, ['FAILED', 'COMPLETED']);
    expect(task.status).toBe('FAILED');
    expect(task.blocker).toMatchObject({ kind: 'error', errorClass: 'PROCESS_CRASH', stageKey: 'investigate' });
    expect(t.services.store.listStages(id).filter((s) => s.stageKey === 'investigate')).toHaveLength(2);
    expect(eventTypes(id)).toContain('STAGE_RETRY');
  });

  it('asks before continuing when a repository has no verification commands', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo({ noPackageJson: true })), 'Untested change');
    const task = await waitForStatus(t, id, ['WAITING_FOR_USER', 'COMPLETED']);
    expect(task.blocker?.kind).toBe('approval');
    const [approval] = (await t.api('GET', '/api/approvals')).body;
    expect(approval.kind).toBe('skip_tests');
    await t.api('POST', `/api/approvals/${approval.id}/approve`, {});
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED']);
    expect(done.status).toBe('COMPLETED');
    expect(done.finalStatus).toBe('NEEDS_USER_ACTION');
  });
});

describe('live control', () => {
  it('pauses a running stage and resumes it', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Slow work [sim:slow]');
    await waitFor(() => t.services.store.latestStage(id, 'investigate'), (s) => s?.status === 'RUNNING', 20_000, 'investigate running');
    expect((await t.api('POST', `/api/tasks/${id}/pause`)).status).toBe(200);
    const paused = t.services.store.getTask(id)!;
    expect(paused.status).toBe('PAUSED');
    expect(t.services.store.latestStage(id, 'investigate')!.status).toBe('PAUSED');
    expect((await t.api('POST', `/api/tasks/${id}/pause`)).status).toBe(409);
    await t.api('POST', `/api/tasks/${id}/resume`);
    await waitFor(() => t.services.store.listStages(id).filter((s) => s.stageKey === 'investigate'), (s) => s.length === 2 && s[1]!.status === 'SUCCESS', 30_000);
    await t.api('POST', `/api/tasks/${id}/cancel`);
  });

  it('cancels a running task', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Slow work [sim:slow]');
    await waitFor(() => t.services.store.latestStage(id, 'investigate'), (s) => s?.status === 'RUNNING', 20_000);
    expect((await t.api('POST', `/api/tasks/${id}/cancel`)).status).toBe(200);
    const task = t.services.store.getTask(id)!;
    expect(task.status).toBe('CANCELLED');
    expect(t.services.store.latestStage(id, 'investigate')!.status).toBe('CANCELLED');
    expect((await t.api('POST', `/api/tasks/${id}/resume`)).status).toBe(409);
  });

  it('reroutes the running stage to another agent without restarting the task', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Slow work [sim:slow]');
    await waitFor(() => t.services.store.latestStage(id, 'investigate'), (s) => s?.status === 'RUNNING', 20_000);
    const res = await t.api('POST', `/api/tasks/${id}/reroute`, { agentId: 'claude', reason: 'Codex is slow today' });
    expect(res.status).toBe(200);
    const stages = await waitFor(() => t.services.store.listStages(id).filter((s) => s.stageKey === 'investigate'), (s) => s.length === 2, 20_000);
    expect(stages[0]).toMatchObject({ status: 'CANCELLED', agentId: 'codex', summary: 'Rerouted to another agent' });
    expect(stages[1]!.agentId).toBe('claude');
    const rerouted = t.services.store.listEvents(id).find((e) => e.type === 'REROUTED');
    expect(rerouted?.message).toBe('Investigator rerouted · Codex (simulated) → Claude Code (simulated) · Reason: Codex is slow today');
    await t.api('POST', `/api/tasks/${id}/cancel`);
  });

  it('queues a directive while running and applies it at the next agent boundary', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Slow work [sim:slow]');
    await waitFor(() => t.services.store.latestStage(id, 'investigate'), (s) => s?.status === 'RUNNING', 20_000);
    const res = await t.api('POST', `/api/tasks/${id}/directives`, { text: 'Do not modify the D1 schema.' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'queued', text: 'Do not modify the D1 schema.' });
    const applied = await waitFor(() => t.services.store.listDirectives(id)[0]!, (d) => d.status === 'applied', 30_000);
    expect(applied.appliedStageKey).toBe('plan');
    await t.api('POST', `/api/tasks/${id}/cancel`);
  });

  it('changes a future stage assignment and rejects changing the running one', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Slow work [sim:slow]');
    await waitFor(() => t.services.store.latestStage(id, 'investigate'), (s) => s?.status === 'RUNNING', 20_000);
    const ok = await t.api('POST', `/api/tasks/${id}/assignments`, { stageKey: 'implement', agentId: 'codex', effort: 'low' });
    expect(ok.status).toBe(200);
    expect(ok.body.assignments.implement).toEqual({ agentId: 'codex', model: 'default', effort: 'low' });
    const running = await t.api('POST', `/api/tasks/${id}/assignments`, { stageKey: 'investigate', agentId: 'claude' });
    expect(running.status).toBe(409);
    await t.api('POST', `/api/tasks/${id}/cancel`);
  });
});

describe('permissions and approvals', () => {
  it('requires a typed confirmation for dangerous commands', async () => {
    const repoPath = await makeRepo({ scripts: { test: 'node -e "0"', build: 'node -e "0" && git reset --hard' } });
    const id = await createTask(t, await addRepo(t, repoPath), 'Dangerous build');
    const task = await waitForStatus(t, id, ['WAITING_FOR_USER', 'COMPLETED']);
    expect(task.blocker?.kind).toBe('approval');
    const [approval] = (await t.api('GET', '/api/approvals')).body;
    expect(approval).toMatchObject({ kind: 'command', risk: 'dangerous', permissionLevel: 5, confirmationPhrase: id });
    expect(t.services.store.latestStage(id, 'test')!.status).toBe('WAITING_APPROVAL');

    const refused = await t.api('POST', `/api/approvals/${approval.id}/approve`, { confirmation: 'yes' });
    expect(refused.status).toBe(422);
    expect((await t.api('POST', `/api/approvals/${approval.id}/approve`, { confirmation: id })).status).toBe(200);
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    expect(done.status).toBe('COMPLETED');
    // The approved stage continued as the same attempt instead of leaving a dangling row.
    expect(t.services.store.listStages(id).filter((s) => s.stageKey === 'test' && s.status === 'WAITING_APPROVAL')).toHaveLength(0);
  });

  it('sends a commit rejected by a pre-commit hook back to the fixer, then commits', async () => {
    const repoPath = await makeRepo({ scripts: { test: 'node -e "0"' } });
    // A docs-guard-like hook: rejects until the fixer has touched the file.
    writeFileSync(
      path.join(repoPath, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\ngrep -q "fixer change" sim-output.md || { echo "docs guard: sim-output.md needs its fixer line"; exit 1; }\n',
      { mode: 0o755 },
    );
    const id = await createTask(t, await addRepo(t, repoPath), 'Ship it', { workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.status).toBe('COMPLETED');
    const keys = t.services.store.listStages(id).map((s) => `${s.stageKey}:${s.status}`);
    expect(keys).toEqual(expect.arrayContaining(['git:FAILED', 'fix:SUCCESS', 'git:SUCCESS']));
    expect(keys.indexOf('git:FAILED')).toBeLessThan(keys.indexOf('fix:SUCCESS'));
    const rejected = t.services.store.listStages(id).find((s) => s.stageKey === 'git' && s.status === 'FAILED')!;
    expect(rejected.errorMessage).toContain('docs guard: sim-output.md needs its fixer line');
    expect(rejected.errorMessage).not.toContain('will be replaced by');
    expect(done.git.commits).toHaveLength(1);
  });

  it('skips an optional deploy stage with no command without asking for approval', async () => {
    const repoId = await addRepo(t, await makeRepo({ scripts: { test: 'node -e "0"', 'test:e2e': 'node -e "console.log(\'4 passed\')"' } }));
    const id = await createTask(t, repoId, 'Document it', { workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    expect(done.status).toBe('COMPLETED');
    // Full Autopilot observes the end-to-end suite itself.
    expect(t.services.store.listTestRuns(id).map((r) => `${r.kind}:${r.status}:${r.summary}`)).toEqual(['test:passed:null', 'e2e:passed:4 passed']);
    expect(t.services.store.listApprovals({ limit: 10 })).toHaveLength(0);
    expect(t.services.store.latestStage(id, 'staging')!.status).toBe('SKIPPED');
    expect(t.services.store.latestStage(id, 'smoke')!.status).toBe('SKIPPED');
  });

  it('gates level 4 stages behind approval and denies cleanly', async () => {
    const repoPath = await makeRepo({ scripts: { test: 'node -e "0"', 'deploy:staging': 'node -e "console.log(\'deployed\')"' } });
    const repoId = await addRepo(t, repoPath);
    const repo = (await t.api('GET', `/api/repositories/${repoId}`)).body;
    await t.api('PATCH', `/api/repositories/${repoId}`, {
      commands: [...repo.commands, { id: 'staging', name: 'staging deploy', command: 'node -e "console.log(1)"', kind: 'deploy-staging', enabled: true, timeoutSec: 60 }],
    });
    const id = await createTask(t, repoId, 'Ship it', { workflowId: 'full-autopilot' });
    const task = await waitForStatus(t, id, ['WAITING_FOR_USER', 'COMPLETED', 'FAILED']);
    expect(task.status).toBe('WAITING_FOR_USER');
    const [approval] = (await t.api('GET', '/api/approvals')).body;
    expect(approval).toMatchObject({ kind: 'stage_permission', stageKey: 'staging', permissionLevel: 4, environment: 'staging' });
    // The git checkpoint committed the task's own file on the task branch before staging.
    expect(task.git.commits).toHaveLength(1);

    await t.api('POST', `/api/approvals/${approval.id}/deny`, { note: 'Not today' });
    const denied = await waitForStatus(t, id, ['FAILED']);
    expect(denied.blocker?.message).toContain('You denied');
    await t.api('POST', `/api/tasks/${id}/retry`, {});
    const [again] = (await waitFor(() => t.api('GET', '/api/approvals'), (r) => r.body.length === 1, 20_000)).body;
    await t.api('POST', `/api/approvals/${again.id}/approve`, {});
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED']);
    expect(done.status).toBe('COMPLETED');
    expect(t.services.store.latestStage(id, 'staging')!.status).toBe('SUCCESS');
    expect(t.services.store.latestStage(id, 'smoke')!.status).toBe('SKIPPED');
  });
});

describe('scheduling', () => {
  it('runs one task per repository at a time', async () => {
    const repoId = await addRepo(t, await makeRepo());
    const first = await createTask(t, repoId, 'First [sim:slow]');
    const second = await createTask(t, repoId, 'Second');
    await waitFor(() => t.services.store.getTask(second)!, (x) => x.blocker?.kind === 'queued', 10_000);
    expect(t.services.store.getTask(second)!.status).toBe('QUEUED');
    expect(t.services.store.getTask(second)!.blocker?.message).toContain(first);
    await t.api('POST', `/api/tasks/${first}/cancel`);
    expect((await waitForStatus(t, second, ['COMPLETED', 'FAILED'])).status).toBe('COMPLETED');
  });
});

describe('restart recovery', () => {
  it('marks work interrupted on shutdown and resumes it after a restart', async () => {
    const repoPath = await makeRepo();
    const dataDir = t.dataDir;
    const id = await createTask(t, await addRepo(t, repoPath), 'Survive a restart [sim:slow]', { supervised: false });
    await waitFor(() => t.services.store.latestStage(id, 'investigate'), (s) => s?.status === 'RUNNING', 20_000);
    await t.close();

    t = await createTestApp({ dataDir, adapters: simAdapters() });
    const task = t.services.store.getTask(id)!;
    expect(task.status).toBe('INTERRUPTED');
    expect(task.blocker?.kind).toBe('interrupted');
    expect(t.services.store.latestStage(id, 'investigate')!.status).toBe('INTERRUPTED');
    expect(t.services.store.listEvents(id).length).toBeGreaterThan(3);

    writeFileSync(path.join(repoPath, 'unrelated.txt'), 'x');
    await t.api('POST', `/api/tasks/${id}/resume`);
    await waitFor(() => t.services.store.listStages(id).filter((s) => s.stageKey === 'investigate' && s.status === 'SUCCESS'), (s) => s.length === 1, 30_000);
    await t.api('POST', `/api/tasks/${id}/cancel`);
  });

  it('withdraws a waiting approval for an optional stage whose command was removed', async () => {
    const dataDir = t.dataDir;
    const repoId = await addRepo(t, await makeRepo({ scripts: { test: 'node -e "0"' } }));
    const repo = (await t.api('GET', `/api/repositories/${repoId}`)).body;
    const staging = { id: 'staging', name: 'staging deploy', command: 'node -e "0"', kind: 'deploy-staging', enabled: true, timeoutSec: 60 };
    await t.api('PATCH', `/api/repositories/${repoId}`, { commands: [...repo.commands, staging] });
    const id = await createTask(t, repoId, 'Ship it', { workflowId: 'full-autopilot' });
    expect((await waitForStatus(t, id, ['WAITING_FOR_USER', 'COMPLETED', 'FAILED'])).blocker?.kind).toBe('approval');
    await t.api('PATCH', `/api/repositories/${repoId}`, { commands: repo.commands });
    await t.close();

    t = await createTestApp({ dataDir, adapters: simAdapters() });
    t.services.engine.schedule(); // as main.ts does after recovery
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    expect(done.status).toBe('COMPLETED');
    expect(t.services.store.listApprovals({ limit: 10 }).map((a) => a.status)).toEqual(['cancelled']);
    expect(t.services.store.latestStage(id, 'staging')!.status).toBe('SKIPPED');
  });

  it('recovers executions left running by a crash', async () => {
    const dataDir = t.dataDir;
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Crash me [sim:slow]', { supervised: false });
    await waitFor(() => t.services.store.listExecutions(id), (e) => e.some((x) => x.status === 'running'), 20_000);
    // Simulate a crash: stop the loop without the graceful shutdown path touching the database.
    const snapshot = t.services.store.getTask(id)!;
    expect(snapshot.status).toBe('RUNNING');
    const other = await createTestApp({ dataDir, adapters: simAdapters() });
    const recovered = other.services.store.getTask(id)!;
    expect(recovered.status).toBe('INTERRUPTED');
    expect(other.services.store.listExecutions(id).some((e) => e.status === 'interrupted')).toBe(true);
    await other.close();
  });
});

describe('secrets', () => {
  it('redacts secrets in directives, command logs and events', async () => {
    const repoPath = await makeRepo({ scripts: { test: 'node -e "console.log(\'API_TOKEN=supersecretvalue123\')"' } });
    const id = await createTask(t, await addRepo(t, repoPath), 'Leaky [sim:slow]');
    const fakeKey = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz'].join('-');
    await t.api('POST', `/api/tasks/${id}/directives`, { text: `use key ${fakeKey} please` });
    await t.api('POST', `/api/tasks/${id}/pause`);
    await t.api('POST', `/api/tasks/${id}/resume`);
    const directive = t.services.store.listDirectives(id)[0]!;
    expect(directive.text).toBe('use key [REDACTED] please');
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    expect(done.status).toBe('COMPLETED');
    const testExec = t.services.store.listExecutions(id).find((e) => e.kind === 'command')!;
    const lines = t.services.store.listLogLines(testExec.id).map((l) => l.text);
    expect(lines.join('\n')).toContain('API_TOKEN=[REDACTED]');
    expect(lines.join('\n')).not.toContain('supersecretvalue123');
    const dump = JSON.stringify(t.services.db.prepare('SELECT * FROM task_events').all());
    expect(dump).not.toContain(fakeKey);
  });
});
