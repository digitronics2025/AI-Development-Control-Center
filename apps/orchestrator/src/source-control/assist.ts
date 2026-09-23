import { randomUUID } from 'node:crypto';
import { AgentGuardError } from '@acc/agent-sdk';
import { git, EMPTY_TREE } from '@acc/git';
import { redact } from '@acc/security';
import { resolveAssignment, type CommitMessageSuggestion, type StageDefinition, type StagedReviewStarted, type TaskSummary } from '@acc/shared';
import type { TaskEngine } from '../engine/engine.js';
import type { AgentRegistry } from '../services/agents.js';
import type { ArtifactService } from '../services/artifacts.js';
import type { RepositoryService } from '../services/repositories.js';
import type { SettingsService } from '../services/settings.js';
import type { Store } from '../store/store.js';
import type { TaskViews } from '../engine/views.js';
import { SourceControlError } from './errors.js';
import { withoutSensitiveFiles } from './preflight.js';
import type { SourceControlService } from './service.js';
import type { RepoState } from './state.js';

/** Bounds for what an agent may see of the staged diff. */
const MESSAGE_DIFF_CHARS = 60_000;
const REVIEW_DIFF_CHARS = 150_000;
const MESSAGE_TIMEOUT_MS = 180_000;

export const STAGED_REVIEW_WORKFLOW = 'staged-review';

export interface AssistDeps {
  sourceControl: SourceControlService;
  repositories: RepositoryService;
  agents: AgentRegistry;
  settings: SettingsService;
  engine: TaskEngine;
  artifacts: ArtifactService;
  store: Store;
  views: TaskViews;
}

export interface LatestStagedReview {
  task: TaskSummary;
  review: string | null;
  verdict: 'PASS' | 'FAIL' | null;
}

/**
 * The redacted staged diff an agent may read: sensitive files are left out
 * entirely (redaction of an environment file is not trustworthy), and the
 * rest is bounded.
 */
async function stagedDiffForAgent(state: RepoState, maxChars: number): Promise<{ diff: string; files: string[]; omitted: string[]; truncated: boolean }> {
  const result = await git(state.root, ['diff', '--cached', ...(state.hasHead ? [] : [EMPTY_TREE]), '--no-color', '--no-ext-diff', '--no-textconv', '-M'], {
    maxOutputBytes: maxChars * 2,
    timeoutMs: 60_000,
  });
  const { patch, omitted } = withoutSensitiveFiles(result.stdout);
  const clean = redact(patch);
  const truncated = Boolean(result.truncated) || clean.length > maxChars;
  const files = state.entries.filter((e) => e.staged && !omitted.includes(e.path)).map((e) => e.path);
  return { diff: truncated ? `${clean.slice(0, maxChars)}\n[diff truncated]` : clean, files, omitted, truncated };
}

/** A generated message is a suggestion: one subject line, an optional short body, nothing else. */
export function parseCommitMessage(output: string): { subject: string; body: string } {
  const text = output
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .trim();
  const lines = text.split('\n');
  const first = lines.findIndex((l) => l.trim());
  const subject = (lines[first] ?? '')
    .trim()
    .replace(/^(subject|commit message|message)\s*:\s*/i, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .slice(0, 100);
  const body = lines
    .slice(first + 1)
    .join('\n')
    .trim()
    .slice(0, 2000);
  return { subject, body };
}

/**
 * AI assistance for Source Control. Git never depends on it: every action
 * works without an agent, and these helpers only read the index.
 */
export class SourceControlAssist {
  private readonly generating = new Set<string>();

  constructor(private readonly d: AssistDeps) {}

  /** One read-only agent run over the staged diff, held in memory: no task, no repository writes. */
  async suggestMessage(repositoryId: string, expectedVersion: string): Promise<CommitMessageSuggestion> {
    const repo = this.d.repositories.record(repositoryId);
    if (this.generating.has(repositoryId)) throw new SourceControlError('DUPLICATE_IN_FLIGHT', 'A commit message is already being generated for this repository.');
    this.generating.add(repositoryId);
    try {
      const state = await this.d.sourceControl.stagedContext(repositoryId, expectedVersion);
      const { diff, files, omitted } = await stagedDiffForAgent(state, MESSAGE_DIFF_CHARS);
      const assignment = resolveAssignment({ key: 'commit-message', role: 'reviewer' } as StageDefinition, {
        roleDefaults: this.d.settings.get().roleDefaults,
        repositoryOverrides: repo.roleOverrides,
      });
      if (!this.d.agents.has(assignment.agentId) || !this.d.agents.isEnabled(assignment.agentId)) {
        throw new SourceControlError('AGENT_UNAVAILABLE', 'The reviewer agent is not available. Write the message yourself, or enable an agent in Settings → Agents & Models.');
      }
      const adapter = this.d.agents.adapter(assignment.agentId);
      const prompt = [
        'Task: SOURCE-CONTROL',
        'Role: committer',
        '',
        'Write a Git commit message for the staged changes below.',
        'Rules: the first line is an imperative summary of at most 72 characters. Optionally add a blank line and at most six short lines saying why.',
        'Reply with the message only: no code fences, quotes, headings or commentary. Do not modify files or run commands.',
        '',
        'Staged files:',
        ...files.map((f) => `- ${f}`),
        ...(omitted.length ? [`(${omitted.length} sensitive file(s) omitted)`] : []),
        '',
        '```diff',
        diff,
        '```',
      ].join('\n');
      let handle;
      try {
        handle = await this.d.agents.launch(assignment.agentId, {
          ...this.d.agents.runtimeOptions(assignment.agentId),
          executionId: randomUUID(),
          cwd: repo.path,
          prompt,
          model: assignment.model,
          effort: assignment.effort,
          permissionLevel: 1,
          timeoutMs: MESSAGE_TIMEOUT_MS,
        }, {
          origin: 'source_control',
          projectId: repositoryId,
          taskId: null,
          runId: null,
          workflowId: null,
          workflowStep: 'commit-message',
          agentRole: 'committer',
          mode: null,
        });
      } catch (error) {
        const reason = error instanceof AgentGuardError ? error.message : `The agent could not start: ${(error as Error).message}`;
        throw new SourceControlError('AGENT_UNAVAILABLE', redact(reason));
      }
      const result = await handle.done;
      if (result.status !== 'succeeded') {
        throw new SourceControlError('AGENT_UNAVAILABLE', redact(result.errorMessage ?? `${adapter.displayName} did not produce a message (${result.status}).`));
      }
      const { subject, body } = parseCommitMessage(redact(result.output));
      if (!subject) throw new SourceControlError('AGENT_UNAVAILABLE', `${adapter.displayName} returned an empty message.`);
      return { subject, body, agentId: assignment.agentId, model: assignment.model };
    } finally {
      this.generating.delete(repositoryId);
    }
  }

  /**
   * Review what is staged with the reviewer role, as a normal read-only task
   * on the built-in Staged Review workflow — so it gets logs, usage-limit
   * handling and an artifact like any other stage, and never edits files.
   */
  async reviewStaged(repositoryId: string, input: { expectedVersion: string; purpose?: string }): Promise<StagedReviewStarted> {
    const state = await this.d.sourceControl.stagedContext(repositoryId, input.expectedVersion);
    const { diff, files, omitted, truncated } = await stagedDiffForAgent(state, REVIEW_DIFF_CHARS);
    const branch = state.branch.head ?? 'detached HEAD';
    const description = [
      input.purpose?.trim() ? `${redact(input.purpose.trim())}\n` : 'Review the staged changes before they are committed.\n',
      `Branch: ${branch}`,
      `Staged files (${files.length}):`,
      ...files.slice(0, 200).map((f) => `- ${f}`),
      ...(omitted.length ? [`Sensitive files left out of the review: ${omitted.join(', ')}`] : []),
      ...(truncated ? ['The staged diff was truncated to fit the review.'] : []),
    ].join('\n');
    const task = await this.d.engine.createTask({
      title: `Review staged changes on ${branch}`,
      description,
      repositoryId,
      workflowId: STAGED_REVIEW_WORKFLOW,
      mode: 'autopilot',
      start: false,
    });
    await this.d.artifacts.write(task.id, { name: 'staged.patch', type: 'staged-diff', content: diff });
    await this.d.engine.start(task.id);
    return { taskId: task.id };
  }

  async latestReview(repositoryId: string): Promise<LatestStagedReview | null> {
    this.d.repositories.record(repositoryId);
    const task = this.d.store.listTasks({ repositoryId, limit: 200 }).find((t) => t.workflowId === STAGED_REVIEW_WORKFLOW);
    if (!task) return null;
    const stage = this.d.store.listStages(task.id).filter((s) => s.role === 'reviewer').at(-1) ?? null;
    return { task: this.d.views.summary(task), review: await this.d.artifacts.latestText(task.id, 'review', 100_000), verdict: stage?.verdict ?? null };
  }
}
