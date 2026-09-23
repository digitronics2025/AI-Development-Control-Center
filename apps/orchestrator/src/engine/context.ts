import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { changesSince, diffSince, status as gitStatus, type GitSnapshot } from '@acc/git';
import { redact } from '@acc/security';
import {
  COMMAND_KIND_LABEL,
  DEFAULT_VERIFY_COMMAND_KINDS,
  ROLE_LABEL,
  type ArtifactType,
  type StageDefinition,
  type StageInstance,
} from '@acc/shared';
import type { ArtifactService } from '../services/artifacts.js';
import type { PromptService } from '../services/prompts.js';
import type { RepositoryRecord, Store, TaskRecord } from '../store/store.js';

const NONE = '(none)';
const MAX_DIFF_CHARS = 150_000;
const MAX_SECTION_CHARS = 60_000;
const MAX_TEXT_ATTACHMENT = 50_000;

/**
 * Prepended to every role prompt, including user-edited ones. Agents that load
 * the operator's own CLI instructions otherwise end with chat-style to-do
 * blocks ("nothing has been saved yet") that contradict what the orchestrator
 * does next — it commits, runs tests and asks for approvals itself.
 */
export const RUN_CONTEXT = [
  'You are running as a subagent of the AI Development Control Center, not in a chat with the operator.',
  'Your reply is saved as this stage\'s artifact and read by the next stage and in the operator\'s dashboard.',
  'Report facts in the requested sections only: no closing recap, summary for a non-technical reader or "what you need to do" block.',
  'The orchestrator handles commits, tests and approvals after you; do not tell the operator how to commit or what has not been saved.',
].join('\n');

function clip(text: string, max = MAX_SECTION_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[truncated ${text.length - max} characters]` : text;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, name: string) => {
    const value = vars[name];
    return value === undefined || value.trim() === '' ? NONE : value;
  });
}

export interface BuiltPrompt {
  prompt: string;
  templateVersion: number;
}

/**
 * Role-specific context (PLAN §17): each stage receives only what its role
 * needs — the investigator gets repository facts, the reviewer gets the diff
 * and test results — instead of the whole repository in every prompt.
 */
export class ContextBuilder {
  /** Current Chairman strategy guidance for a task, set once the Chairman exists. */
  guidance: (taskId: string) => string | null = () => null;

  constructor(
    private readonly store: Store,
    private readonly artifacts: ArtifactService,
    private readonly prompts: PromptService,
  ) {}

  private async artifactsOf(taskId: string, types: ArtifactType[], maxEach = MAX_SECTION_CHARS): Promise<string> {
    const recs = this.store.listArtifacts(taskId).filter((a) => types.includes(a.type));
    const parts: string[] = [];
    for (const rec of recs) {
      try {
        const { content } = await this.artifacts.read(rec, maxEach);
        parts.push(recs.length > 1 ? `### ${rec.name}\n\n${content}` : content);
      } catch {
        /* missing file: skip */
      }
    }
    return clip(parts.join('\n\n'));
  }

  private async latest(taskId: string, type: ArtifactType): Promise<string> {
    return (await this.artifacts.latestText(taskId, type, MAX_SECTION_CHARS)) ?? '';
  }

  private repositoryFacts(repo: RepositoryRecord, task: TaskRecord): string {
    const commands = repo.commands.filter((c) => c.enabled).map((c) => `- ${c.name} (${c.kind}): \`${c.command}\``);
    return [
      `- Path: ${repo.path}`,
      `- Tooling: ${repo.tooling.join(', ') || 'not detected'}`,
      `- Task branch: ${task.git.taskBranch ?? 'not created yet'}`,
      `- Baseline commit: ${task.git.baselineCommit ?? 'not recorded yet'}`,
      commands.length ? `- Configured commands:\n${commands.map((c) => `  ${c}`).join('\n')}` : '- Configured commands: none',
    ].join('\n');
  }

  private testResults(task: TaskRecord): string {
    const runs = this.store.listTestRuns(task.id);
    if (!runs.length) return '';
    const lastStage = runs.at(-1)!.stageId;
    const latest = runs.filter((r) => r.stageId === lastStage);
    const lines = latest.map((r) => `- ${r.name}: ${r.status}${r.exitCode !== null ? ` (exit ${r.exitCode})` : ''}${r.summary ? ` — ${r.summary}` : ''}`);
    const failed = latest.find((r) => r.status === 'failed' && r.executionId);
    if (failed?.executionId) {
      const tail = this.store.tailLogLines(failed.executionId, 80).map((l) => l.text);
      lines.push('', `Output of ${failed.name} (last ${tail.length} lines):`, '```', ...tail, '```');
    }
    // A Git checkpoint the repository rejected after these checks passed (a
    // pre-commit hook) is the failure the fix stage is here for.
    const stages = this.store.listStages(task.id);
    const testsAt = stages.find((s) => s.id === lastStage)?.createdAt ?? '';
    const rejected = stages.filter((s) => s.kind === 'git' && s.status === 'FAILED' && s.createdAt >= testsAt).at(-1);
    if (rejected?.errorMessage) {
      lines.push('', `${rejected.name} was rejected by the repository (its commit hook):`, '```', rejected.errorMessage, '```');
    }
    return lines.join('\n');
  }

  /**
   * Active directives only: removed and superseded ones never reach a stage,
   * routing directives act through assignments, and next-stage-only ones
   * reach just the stage they were applied to.
   */
  private directives(task: TaskRecord, def: StageDefinition, stage: StageInstance): string {
    return this.store
      .listDirectives(task.id)
      .filter((d) => d.state === 'active' && d.kind !== 'routing')
      .filter((d) => d.scope === 'CURRENT_TASK' || (d.appliedStageKey === def.key && (d.appliedAt ?? '') >= stage.createdAt))
      .map((d) => `- [${d.createdAt}]${d.kind === 'constraint' ? ' (constraint)' : d.kind === 'requirement' ? ' (completion requirement)' : ''} ${d.text}`)
      .join('\n');
  }

  private previousAttempt(task: TaskRecord, def: StageDefinition, current: StageInstance): string {
    const earlier = this.store
      .listStages(task.id)
      .filter((s) => s.stageKey === def.key && s.id !== current.id && ['FAILED', 'CANCELLED', 'INTERRUPTED', 'PAUSED'].includes(s.status));
    const last = earlier.at(-1);
    if (!last) return '';
    const exec = this.store.listExecutions(task.id).filter((e) => e.stageId === last.id).at(-1);
    const tail = exec ? this.store.tailLogLines(exec.id, 40).map((l) => l.text) : [];
    return [
      `A previous attempt of this stage by ${last.agentId ?? 'the system'} ended as ${last.status}${last.errorMessage ? `: ${last.errorMessage}` : ''}.`,
      last.summary ? `Summary: ${last.summary}` : '',
      tail.length ? ['Last output:', '```', ...tail, '```'].join('\n') : '',
      'Continue from the current repository state; do not restart from zero unless necessary.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private async attachments(task: TaskRecord): Promise<string> {
    const parts: string[] = [];
    for (const att of task.attachments) {
      const isText = /\.(md|txt|log|json|ya?ml|csv|diff|patch|ts|js|tsx|jsx|py|java|kt|go|rs|css|html|xml|sql)$/i.test(att.name);
      if (isText && att.size <= MAX_TEXT_ATTACHMENT) {
        try {
          const text = redact(await readFile(att.path, 'utf8'));
          parts.push(`### ${att.name}\n\n\`\`\`\n${text}\n\`\`\``);
          continue;
        } catch {
          /* fall through to listing */
        }
      }
      parts.push(`- ${att.name}: ${att.path}`);
    }
    return parts.join('\n\n');
  }

  async build(task: TaskRecord, def: StageDefinition, stage: StageInstance): Promise<BuiltPrompt> {
    const repo = this.store.getRepository(task.repositoryId);
    if (!repo) throw new Error('Repository record is missing');
    const template = this.prompts.get(def.role);
    const baseline = task.git.baselineSnapshotId ? this.store.getSnapshot(task.git.baselineSnapshotId) : null;
    const snapshot: GitSnapshot | null = baseline ? { branch: baseline.branch, head: baseline.head, files: baseline.files } : null;

    const needsDiff = ['reviewer', 'fixer', 'verifier'].includes(def.role) || def.role === 'implementer';
    let diff = '';
    let changedFiles = '';
    if (snapshot && needsDiff) {
      try {
        const { diff: raw, truncated } = await diffSince(repo.path, snapshot, { maxBytes: MAX_DIFF_CHARS });
        diff = redact(raw) + (truncated ? '\n[diff truncated]' : '');
        const files = await changesSince(repo.path, snapshot);
        changedFiles = files.map((f) => `- ${f.path} (${f.status}, ${f.origin === 'task' ? 'task change' : f.origin === 'both' ? 'task change on top of pre-existing user work' : 'pre-existing user work'})`).join('\n');
      } catch {
        diff = '(diff unavailable)';
      }
    } else if (!snapshot && needsDiff) {
      // A Staged Review task has no baseline: it reviews the staged diff
      // Source Control saved (already redacted and bounded) when it started.
      const staged = await this.artifacts.latestText(task.id, 'staged-diff', MAX_DIFF_CHARS);
      if (staged) {
        diff = staged;
        changedFiles = [...new Set([...staged.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)].map((m) => m[1]!))].map((f) => `- ${f} (staged)`).join('\n');
      }
    }

    let gitStatusText: string;
    try {
      gitStatusText = (await gitStatus(repo.path)).slice(0, 80).map((e) => `${e.code} ${e.path}`).join('\n') || 'clean';
    } catch {
      gitStatusText = 'not a Git repository';
    }

    const verifyKinds = new Set(DEFAULT_VERIFY_COMMAND_KINDS);
    const vars: Record<string, string> = {
      task_id: task.id,
      title: task.title,
      role: ROLE_LABEL[def.role],
      request: `# ${task.title}\n\n${task.description}`,
      repository_name: repo.name,
      repository_path: repo.path,
      repository_facts: this.repositoryFacts(repo, task),
      git_status: gitStatusText,
      investigation: await this.artifactsOf(task.id, ['investigation']),
      plan: await this.latest(task.id, 'plan'),
      implementation_report: await this.artifactsOf(task.id, ['implementation-report', 'fix-report'], 20_000),
      review: await this.latest(task.id, 'review'),
      test_results: this.testResults(task),
      diff: clip(diff, MAX_DIFF_CHARS),
      changed_files: changedFiles,
      directives: this.directives(task, def, stage),
      attachments: await this.attachments(task),
      previous_attempt: this.previousAttempt(task, def, stage),
      verification_commands: repo.commands
        .filter((c) => c.enabled && verifyKinds.has(c.kind))
        .map((c) => `- ${COMMAND_KIND_LABEL[c.kind]}: \`${c.command}\``)
        .join('\n'),
      preexisting_changes: task.git.preexistingChanges.length ? task.git.preexistingChanges.join(', ') : 'none',
      fix_cycle: String(task.fixCycles),
    };
    const header = `Task: ${task.id}\nRole: ${def.role}\nStage: ${def.key}\nWorking directory: ${path.resolve(repo.path)}\n\n${RUN_CONTEXT}\n\n`;
    const guidance = this.guidance(task.id);
    // Chairman guidance follows the role template so user-edited templates still receive it.
    const supervisor = guidance ? `\n\n## Chairman guidance (supervisor of this task)\n\n${guidance}\n` : '';
    return { prompt: header + renderTemplate(template.body, vars) + supervisor, templateVersion: template.version };
  }
}
