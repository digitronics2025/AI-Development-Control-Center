import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter, type AgentExecutionHandle, type AgentExecutionInput } from '@acc/agent-sdk';
import { git } from '@acc/git';
import type { ToolExecution } from '@acc/shared';
import { z } from 'zod';
import { newId } from '../src/store/store.js';
import { addRepo, createTask, createTestApp, makeRepo, waitFor, waitForStatus, type TestApp } from './helpers.js';

/** A simulated agent that remembers what each run was given. */
class RecordingAdapter extends SimulatedAgentAdapter {
  readonly inputs: AgentExecutionInput[] = [];
  override execute(input: AgentExecutionInput): Promise<AgentExecutionHandle> {
    this.inputs.push(input);
    return super.execute(input);
  }
}

let t: TestApp;
let claude: RecordingAdapter;
let codex: RecordingAdapter;

beforeEach(async () => {
  SimulatedAgentAdapter.reset();
  claude = new RecordingAdapter('claude', 'Claude Code (simulated)', 5);
  codex = new RecordingAdapter('codex', 'Codex (simulated)', 5);
  t = await createTestApp({ adapters: [codex, claude] });
});

afterEach(async () => {
  await t.close();
});

async function patchLearning(values: Record<string, unknown>) {
  const current = (await t.api('GET', '/api/settings')).body.learning;
  const res = await t.api('PATCH', '/api/settings', { learning: { ...current, ...values } });
  expect(res.status).toBe(200);
}

const learning = () => t.services.learning;

/** Tool-layer call rows as the tool door records them. */
function toolCall(taskId: string, over: Partial<ToolExecution>): void {
  t.services.toolStore.insertExecution({
    id: newId(),
    taskId,
    stageId: null,
    sessionId: null,
    capability: 'shell.run',
    providerId: null,
    origin: 'agent',
    decision: 'deny',
    routeReason: null,
    permissionLevel: 1,
    risk: 'safe',
    effects: [],
    status: 'failed',
    summary: 'not installed',
    errorCode: 'NOT_INSTALLED',
    inputSummary: '{}',
    attempt: 1,
    recoveryOf: null,
    artifacts: [],
    filesChanged: [],
    networkTargets: [],
    evidence: [],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
    ...over,
  } as ToolExecution);
}

/**
 * A completed Quick Change task, with the friction a test needs recorded
 * after it finished (learning off while it runs, so exactly one review
 * happens — the one this helper queues).
 */
async function finishedTask(repoId: string, text: string, friction: { fixCycles?: number; missing?: string } = {}): Promise<string> {
  await patchLearning({ enabled: false });
  // Earlier simulated tasks leave their output uncommitted; a new task would report it as mixed with your work.
  const repoPath = t.services.store.getRepository(repoId)!.path;
  await git(repoPath, ['add', '-A']);
  await git(repoPath, ['commit', '-q', '-m', 'between tasks', '--allow-empty']);
  const id = await createTask(t, repoId, text, { workflowId: 'quick-change' });
  await waitForStatus(t, id, ['COMPLETED']);
  if (friction.fixCycles) t.services.store.updateTask(id, { fixCycles: friction.fixCycles });
  if (friction.missing) toolCall(id, { providerId: friction.missing, summary: `${friction.missing} is not installed` });
  await patchLearning({ enabled: true });
  learning().enqueue(id, true);
  await learning().idle();
  return id;
}

/** The prompt the implementer of a task was given. */
const implementPrompt = async (taskId: string) => [...claude.inputs, ...codex.inputs].find((r) => r.prompt.startsWith(`Task: ${taskId}
Role: implementer`))?.prompt ?? '';

describe('learning loop', () => {
  it('reviews a task that needed several rounds of fixing, and waits for a second task before acting', async () => {
    const repo = await makeRepo({
      scripts: { test: 'node check.js' },
      files: { 'check.js': "const fs=require('fs');const n=fs.existsSync('sim-output.md')?fs.readFileSync('sim-output.md','utf8').split('\\n').filter(Boolean).length:0;process.exit(n>=3?0:1);" },
    });
    const repoId = await addRepo(t, repo);
    const id = await createTask(t, repoId, 'Add a heading', { workflowId: 'quick-change', supervised: false });
    await waitForStatus(t, id, ['COMPLETED'], 60_000);
    await waitFor(() => learning().store.review(id)?.status, (s) => s === 'done', 30_000, 'review done');
    await learning().idle();

    const review = learning().store.review(id)!;
    expect(review.reviewer).toBe('model');
    expect(review.signals.map((s) => s.kind)).toContain('fix_loops');
    expect(review.findingIds).toHaveLength(1);
    const finding = learning().store.finding(review.findingIds[0]!)!;
    expect(finding).toMatchObject({ kind: 'process', status: 'open', taskCount: 1, proposal: { type: 'ADD_LESSON' } });
    expect(finding.statusReason).toMatch(/acts after 2/);
    expect(learning().store.listImprovements()).toEqual([]);
    // The review's model call is recorded against the task like every other Chairman call.
    const steps = t.services.db.prepare('SELECT workflow_step FROM usage_events WHERE task_id = ?').all(id) as Array<{ workflow_step: string }>;
    expect(steps.map((s) => s.workflow_step)).toContain('learning');
  });

  it('records a clean run as skipped without asking a model', async () => {
    const repoId = await addRepo(t, await makeRepo());
    const before = claude.inputs.length + codex.inputs.length;
    const id = await createTask(t, repoId, 'Tidy the readme', { workflowId: 'quick-change' });
    await waitForStatus(t, id, ['COMPLETED']);
    await waitFor(() => learning().store.review(id)?.status, (s) => s === 'skipped', 15_000, 'review skipped');
    const runsForTask = [...claude.inputs, ...codex.inputs].slice(before).filter((r) => /^Mode: learning$/m.test(r.prompt));
    expect(runsForTask).toEqual([]);
    expect(learning().store.review(id)!.summary).toMatch(/Nothing slowed/);
  });

  it('adopts a lesson after the second task, sends it to later prompts, and undoes it when the problem keeps coming back', async () => {
    const repoId = await addRepo(t, await makeRepo());
    await finishedTask(repoId, 'First change', { fixCycles: 2 });
    const second = await finishedTask(repoId, 'Second change', { fixCycles: 3 });
    const [imp] = learning().store.listImprovements();
    expect(imp).toMatchObject({ kind: 'lesson', status: 'trial', scope: 'repository', repositoryId: repoId, trial: { target: 3, seen: 0, recurrences: 0 } });
    expect(learning().store.finding(imp!.findingId!)).toMatchObject({ status: 'adopted', taskCount: 2 });
    expect(learning().store.review(second)!.findingIds).toContain(imp!.findingId);

    // A later task in this repository carries the lesson; another repository does not.
    const clean = await finishedTask(repoId, 'Third change');
    const prompt = await implementPrompt(clean);
    expect(prompt).toContain('## Lessons from earlier tasks');
    expect(prompt).toContain(imp!.content);
    const otherRepo = await addRepo(t, await makeRepo());
    const elsewhere = await finishedTask(otherRepo, 'Unrelated change');
    expect(await implementPrompt(elsewhere)).not.toContain('Lessons from earlier tasks');
    expect(learning().store.improvement(imp!.id)!.trial).toMatchObject({ seen: 1, recurrences: 0 });

    // The same friction twice more: it did not help, so the Chairman undoes it.
    await finishedTask(repoId, 'Fourth change', { fixCycles: 2 });
    expect(learning().store.improvement(imp!.id)).toMatchObject({ status: 'trial', trial: { seen: 2, recurrences: 1 } });
    await finishedTask(repoId, 'Fifth change', { fixCycles: 2 });
    await waitFor(() => learning().store.improvement(imp!.id)!.status, (s) => s === 'ineffective', 5_000, 'undone');
    expect(learning().store.improvement(imp!.id)).toMatchObject({ revertedBy: 'chairman', trial: { seen: 3, recurrences: 2 } });
    expect(learning().store.finding(imp!.findingId!)!.status).toBe('failed');

    // Never re-adopted on its own, and no longer sent.
    const after = await finishedTask(repoId, 'Sixth change', { fixCycles: 2 });
    expect(learning().store.listImprovements().filter((i) => i.status === 'trial' || i.status === 'active')).toEqual([]);
    expect(await implementPrompt(after)).not.toContain(imp!.content);
    // Re-reviewing a task does not count it twice.
    learning().enqueue(after, true);
    await learning().idle();
    expect(learning().store.finding(imp!.findingId!)!.taskCount).toBe(learning().store.observationTasks(imp!.findingId!).length);
  }, 180_000); // runs several full tasks: ~20 s alone, far longer when the whole suite shares the machine

  it('writes a skill, loads it into Claude runs, points other agents at the file, and deletes it when undone', async () => {
    const repoId = await addRepo(t, await makeRepo());
    await finishedTask(repoId, '[sim:learning-skill] One', { fixCycles: 2 });
    await finishedTask(repoId, '[sim:learning-skill] Two', { fixCycles: 2 });
    const [imp] = learning().store.listImprovements();
    expect(imp).toMatchObject({ kind: 'skill_authored', content: 'sim-playbook', status: 'trial' });
    const file = learning().managed.skillFile('repository', repoId, 'sim-playbook');
    expect(readFileSync(file, 'utf8')).toMatch(/^---\nname: sim-playbook\n/);

    const pluginDir = learning().managed.dirFor('repository', repoId);
    const claudeBefore = claude.inputs.length;
    const codexBefore = codex.inputs.length;
    await finishedTask(repoId, 'Uses the skill');
    const claudeRun = claude.inputs.slice(claudeBefore).find((r) => /Role: implementer/.test(r.prompt))!;
    expect(claudeRun.pluginDirs).toEqual([pluginDir]);
    expect(claudeRun.prompt).toContain('Skill /acc-repo:sim-playbook is loaded for this run');
    const codexRun = codex.inputs.slice(codexBefore).find((r) => /Role: reviewer/.test(r.prompt))!;
    expect(codexRun.prompt).toContain(`read ${path.resolve(file)}`);

    const undo = await t.api('POST', `/api/learning/improvements/${imp!.id}/revert`);
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ status: 'reverted', revertedBy: 'user' });
    expect(existsSync(file)).toBe(false);
    expect(await learning().managed.pluginDirs(repoId)).toEqual([]);
    expect((await t.api('POST', `/api/learning/improvements/${imp!.id}/revert`)).status).toBe(409);
  });

  it('installs a missing catalog program on its own, through the tool door', async () => {
    const calls: unknown[] = [];
    t.services.tools.unregisterProvider('installer');
    t.services.tools.registerProvider({
      id: 'installer',
      name: 'Fake installer',
      description: 'test',
      category: 'system',
      builtin: true,
      detect: async () => ({ installed: true, version: null, path: null, auth: { required: false, state: 'not_required', message: null }, message: null }),
      operations: [
        {
          id: 'software.install',
          title: 'Install',
          description: 'test',
          input: z.object({ toolId: z.string() }),
          level: 3,
          classify: () => ({ level: 3, risk: 'elevated', reasons: ['Installs software for the whole user account'], effects: ['persistence', 'network'], production: false }),
          run: async (input: unknown) => {
            calls.push(input);
            return { ok: true, summary: 'Installed jq' };
          },
        },
      ],
    });
    const repoId = await addRepo(t, await makeRepo());
    const id = await finishedTask(repoId, '[sim:learning-none] Needs jq', { missing: 'jq' });
    expect(calls).toEqual([{ toolId: 'jq' }]);
    const [imp] = learning().store.listImprovements();
    expect(imp).toMatchObject({ kind: 'tool_installed', scope: 'global', content: 'jq', source: 'winget:jqlang.jq', status: 'trial' });
    const [exec] = t.services.toolStore.listExecutions({ capability: 'software.install' });
    expect(exec).toMatchObject({ origin: 'chairman', status: 'succeeded', permissionLevel: 3 });
    expect(learning().store.review(id)!.reviewer).toBe('model');
  });

  it('asks you when the execution policy needs approval, and installs when you say so', async () => {
    const calls: unknown[] = [];
    t.services.tools.unregisterProvider('installer');
    t.services.tools.registerProvider({
      id: 'installer',
      name: 'Fake installer',
      description: 'test',
      category: 'system',
      builtin: true,
      detect: async () => ({ installed: true, version: null, path: null, auth: { required: false, state: 'not_required', message: null }, message: null }),
      operations: [{ id: 'software.install', title: 'Install', description: 'test', input: z.object({ toolId: z.string() }), level: 3, run: async (input: unknown) => (calls.push(input), { ok: true, summary: 'ok' }) }],
    });
    const settings = (await t.api('GET', '/api/settings')).body;
    expect((await t.api('PATCH', '/api/settings', { execution: { ...settings.execution, policyMode: 'safe' } })).status).toBe(200);
    const repoId = await addRepo(t, await makeRepo());
    await finishedTask(repoId, '[sim:learning-none] Needs rg', { missing: 'rg' });
    expect(calls).toEqual([]);
    const [finding] = learning().store.listFindings();
    expect(finding).toMatchObject({ status: 'needs_you', proposal: { type: 'INSTALL_TOOL', toolId: 'ripgrep' } });
    expect(finding!.statusReason).toMatch(/needs your approval/);

    const act = await t.api('POST', `/api/learning/findings/${finding!.id}/act`);
    expect(act.status).toBe(200);
    expect(calls).toEqual([{ toolId: 'ripgrep' }]);
    expect(act.body.improvement).toMatchObject({ kind: 'tool_installed', content: 'ripgrep' });
    expect(act.body.improvement.reason).toMatch(/at your request/);
  });

  it('refuses unsafe lessons and findings that cite nothing recorded', async () => {
    const repoId = await addRepo(t, await makeRepo());
    await finishedTask(repoId, '[sim:learning-unsafe] One', { fixCycles: 2 });
    await finishedTask(repoId, '[sim:learning-unsafe] Two', { fixCycles: 2 });
    const [unsafe] = learning().store.listFindings();
    expect(unsafe).toMatchObject({ status: 'failed' });
    expect(unsafe!.statusReason).toMatch(/overrides? instructions|Git history/);
    expect(learning().store.listImprovements()).toEqual([]);

    const otherRepo = await addRepo(t, await makeRepo());
    const id = await finishedTask(otherRepo, '[sim:learning-uncited] Three', { fixCycles: 2 });
    const review = learning().store.review(id)!;
    expect(review.findingIds).toEqual([]);
    expect(review.error).toMatch(/cites no recorded signal/);
  });

  it('falls back to the rules when the model is down', async () => {
    const repoId = await addRepo(t, await makeRepo());
    await patchLearning({ autonomy: 'propose' });
    const id = await finishedTask(repoId, '[sim:chairman-down] Needs gh', { missing: 'gh' });
    const review = learning().store.review(id)!;
    expect(review.reviewer).toBe('rules');
    expect(review.error).toMatch(/Model review unavailable/);
    const [finding] = learning().store.listFindings();
    expect(finding).toMatchObject({ kind: 'missing_tool', observed: true, status: 'needs_you', proposal: { type: 'INSTALL_TOOL', toolId: 'gh' } });
    expect(finding!.statusReason).toMatch(/propose rather than act/);
  });

  it('serves the overview and per-task views, and guards every action', async () => {
    const repoId = await addRepo(t, await makeRepo());
    const id = await finishedTask(repoId, 'Once', { fixCycles: 2 });
    const overview = await t.api('GET', '/api/learning');
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({ counts: { findingsOpen: 1, improvementsLive: 0, reviewed: 1 }, settings: { enabled: true, autonomy: 'act' } });
    expect(overview.body.reviews[0]).toMatchObject({ taskId: id, taskTitle: 'Once', status: 'done' });
    expect(overview.body.log.length).toBeGreaterThan(0);

    const view = await t.api('GET', `/api/learning/tasks/${id}`);
    expect(view.body.findings).toHaveLength(1);
    expect((await t.api('GET', '/api/learning/tasks/NOPE')).status).toBe(404);

    const findingId = view.body.findings[0].id as string;
    const act = await t.api('POST', `/api/learning/findings/${findingId}/act`);
    expect(act.status).toBe(200);
    expect(act.body.improvement).toMatchObject({ kind: 'lesson', status: 'trial' });
    expect((await t.api('POST', `/api/learning/findings/${findingId}/act`)).status).toBe(409);
    expect((await t.api('POST', `/api/learning/findings/${findingId}/dismiss`)).status).toBe(409);
    expect((await t.api('POST', '/api/learning/findings/NOPE/dismiss')).status).toBe(404);
    expect((await t.api('POST', '/api/learning/improvements/NOPE/revert')).status).toBe(404);

    const queued = await t.api('POST', `/api/learning/tasks/${id}/review`);
    expect(queued.status).toBe(202);
    await learning().idle();
    const running = await createTask(t, repoId, '[sim:slow] Still going', { workflowId: 'quick-change' });
    expect((await t.api('POST', `/api/learning/tasks/${running}/review`)).status).toBe(409);
    await t.api('POST', `/api/tasks/${running}/cancel`);
  });

  it('dismisses a finding you do not want', async () => {
    const repoId = await addRepo(t, await makeRepo());
    await finishedTask(repoId, 'Once', { fixCycles: 2 });
    const [finding] = learning().store.listFindings();
    const res = await t.api('POST', `/api/learning/findings/${finding!.id}/dismiss`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'dismissed' });
  });

  it('reviews a task that got stuck, and looks again once it finishes', async () => {
    const repo = await makeRepo({ scripts: { test: 'node check.js' }, files: { 'check.js': "console.log('1 failed');process.exit(1);" } });
    const repoId = await addRepo(t, repo);
    const id = await createTask(t, repoId, 'Stuck on failing checks', { workflowId: 'quick-change', supervised: false, maxFixCycles: 0 });
    await waitForStatus(t, id, ['WAITING_FOR_USER']);
    await waitFor(() => learning().store.review(id)?.status, (s) => s === 'done', 15_000, 'stuck review');
    const stuck = learning().store.review(id)!;
    expect(stuck.signals.map((s) => s.kind)).toContain('task_stuck');
    expect(stuck.signals.find((s) => s.kind === 'task_stuck')!.key).toBe('fix_limit');

    // The operator fixes the checks and resumes; the finished run is reviewed again.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(repo, 'check.js'), "console.log('1 passed');");
    await git(repo, ['commit', '-qam', 'fix checks']);
    expect((await t.api('POST', `/api/tasks/${id}/resume`)).status).toBe(200);
    await waitForStatus(t, id, ['COMPLETED']);
    await waitFor(() => learning().store.review(id), (r) => Boolean(r && r.finishedAt && r.finishedAt > stuck.finishedAt! && !r.signals.some((s) => s.kind === 'task_stuck')), 15_000, 're-review');
  });

  it('does nothing while learning is off', async () => {
    await patchLearning({ enabled: false });
    const repoId = await addRepo(t, await makeRepo());
    const id = await createTask(t, repoId, 'Quiet', { workflowId: 'quick-change' });
    await waitForStatus(t, id, ['COMPLETED']);
    await new Promise((r) => setTimeout(r, 100));
    expect(learning().store.review(id)).toBeNull();
  });
});

describe('learning after a restart', () => {
  it('finishes a review the restart interrupted', async () => {
    const dataDir = t.dataDir;
    const repoId = await addRepo(t, await makeRepo());
    await patchLearning({ enabled: false });
    const id = await createTask(t, repoId, 'Before the restart', { workflowId: 'quick-change' });
    await waitForStatus(t, id, ['COMPLETED']);
    t.services.store.updateTask(id, { fixCycles: 2 });
    await patchLearning({ enabled: true });
    learning().store.queueReview(id, repoId);
    learning().store.updateReview(id, { status: 'running' });
    await t.close();

    SimulatedAgentAdapter.reset();
    t = await createTestApp({ dataDir, adapters: [new SimulatedAgentAdapter('codex', 'Codex (simulated)', 5), new SimulatedAgentAdapter('claude', 'Claude Code (simulated)', 5)] });
    await waitFor(() => t.services.learning.store.review(id)?.status, (s) => s === 'done', 15_000, 'review resumed');
    expect(t.services.learning.store.review(id)!.findingIds).toHaveLength(1);
  });
});
