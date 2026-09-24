import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { changesSince, diffSince, status as gitStatus, type GitSnapshot } from '@acc/git';
import { redact } from '@acc/security';
import {
  COMMAND_KIND_LABEL,
  DEFAULT_VERIFY_COMMAND_KINDS,
  PLACEHOLDER_PATTERN,
  ROLE_LABEL,
  type ArtifactType,
  type PromptPlaceholder,
  type StageDefinition,
  type StageInstance,
} from '@acc/shared';
import type { ArtifactService } from '../services/artifacts.js';
import type { PromptService } from '../services/prompts.js';
import type { RepositoryRecord, Store, TaskRecord } from '../store/store.js';
import { agentWorkdir, taskRepositories, type TaskRepository } from './task-repositories.js';
import { taskWorkdir } from './workdir.js';

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
  'Only your final message is kept: put the whole report in it, under the headings your role instructions ask for.',
  'Report facts in the requested sections only: no closing recap, summary for a non-technical reader or "what you need to do" block.',
  'Lines starting with BLOCKED ON OPERATOR:, NEEDS OPERATOR:, CAUSE: and VERDICT: are read by the orchestrator; write them exactly as your role instructions show, each on its own line.',
  'The orchestrator handles commits, tests and approvals after you; do not tell the operator how to commit or what has not been saved.',
].join('\n');

function clip(text: string, max = MAX_SECTION_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n\n[truncated ${text.length - max} characters]` : text;
}

/** Fill `{{name}}` placeholders; an unknown or empty one renders as "(none)" so a prompt never fails for want of a value. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(new RegExp(PLACEHOLDER_PATTERN), (_m, name: string) => {
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
  /** Environment report and Control Center tools for a stage, set once the tool layer exists. */
  toolSections: (task: TaskRecord, def: StageDefinition, repo: RepositoryRecord) => Promise<string> = async () => '';
  /** Lessons and learned skills from earlier tasks, set once the learning loop exists (docs/systems/learning.md). */
  lessons: (task: TaskRecord, def: StageDefinition, stage: StageInstance) => string = () => '';
  /** Managed skill plugins a stage run loads (`--plugin-dir`), set once the learning loop exists. */
  pluginDirs: (task: TaskRecord) => Promise<string[]> = async () => [];

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

  /**
   * What an agent needs to know about a task across repositories
   * (docs/plans/MULTI_REPO_TASKS_PLAN.md): the workspace layout, and for each
   * repository its folder, facts, Git status and diff — the diffs sharing one
   * size bound, paths written from the workspace root.
   */
  private async workspaceFacts(task: TaskRecord, units: TaskRepository[], needsDiff: boolean): Promise<{ facts: string; gitStatus: string; diff: string; changedFiles: string; commands: string }> {
    const verifyKinds = new Set(DEFAULT_VERIFY_COMMAND_KINDS);
    const facts: string[] = [
      'This task works in several repositories at once. Your working directory is the task workspace; each repository is a folder in it, checked out on its own task branch:',
      '',
      ...units.map((u) => `- ${u.folder}/ — ${u.repo.name}${u.primary ? ' (primary)' : ''}`),
      '',
      'Write paths from the workspace root (e.g. `' + (units[1]?.folder ?? 'web') + '/src/…`). Run Git and each repository\'s commands inside its folder, never at the workspace root, which is not a repository. A folder may carry its own AGENTS.md or CLAUDE.md: read the one for a folder before changing files in it.',
      '',
    ];
    const status: string[] = [];
    const diffs: string[] = [];
    const changed: string[] = [];
    const commands: string[] = [];
    let budget = MAX_DIFF_CHARS;
    for (const u of units) {
      const cmds = u.repo.commands.filter((c) => c.enabled).map((c) => `- ${c.name} (${c.kind}): \`${c.command}\``);
      facts.push(
        `### ${u.folder}/ — ${u.repo.name}`,
        '',
        `- Tooling: ${u.repo.tooling.join(', ') || 'not detected'}`,
        `- Task branch: ${u.git.taskBranch ?? 'not created yet'}`,
        `- Baseline commit: ${u.git.baselineCommit ?? 'not recorded yet'}`,
        cmds.length ? `- Configured commands (run inside ${u.folder}/):\n${cmds.map((c) => `  ${c}`).join('\n')}` : '- Configured commands: none',
        '',
      );
      commands.push(...u.repo.commands.filter((c) => c.enabled && verifyKinds.has(c.kind)).map((c) => `- ${u.folder}/ ${COMMAND_KIND_LABEL[c.kind]}: \`${c.command}\``));
      try {
        const entries = (await gitStatus(u.workdir)).slice(0, 40).map((e) => `${e.code} ${u.folder}/${e.path}`);
        status.push(...(entries.length ? entries : [`${u.folder}/: clean`]));
      } catch {
        status.push(`${u.folder}/: not available`);
      }
      const baseline = u.git.baselineSnapshotId ? this.store.getSnapshot(u.git.baselineSnapshotId) : null;
      if (!needsDiff || !baseline) continue;
      try {
        const snapshot: GitSnapshot = { branch: baseline.branch, head: baseline.head, files: baseline.files };
        const files = await changesSince(u.workdir, snapshot);
        changed.push(...files.map((f) => `- ${u.folder}/${f.path} (${f.status}, task change)`));
        if (budget > 0) {
          const { diff: raw, truncated } = await diffSince(u.workdir, snapshot, { maxBytes: budget, prefix: u.folder });
          budget -= raw.length;
          if (raw) diffs.push(redact(raw) + (truncated ? '\n[diff truncated]' : ''));
        }
      } catch {
        diffs.push(`(${u.folder}/: diff unavailable)`);
      }
    }
    return { facts: facts.join('\n').trimEnd(), gitStatus: status.join('\n'), diff: diffs.join('\n'), changedFiles: changed.join('\n'), commands: commands.join('\n') };
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
    const workdir = taskWorkdir(task, repo);
    const units = taskRepositories(this.store, task);
    const workspace = units.length > 1 ? await this.workspaceFacts(task, units, true) : null;

    // Every role gets the diff: the investigator and planner are read-only,
    // but a root-cause return or a re-plan is judged on the work so far.
    let diff = '';
    let changedFiles = '';
    if (workspace) {
      diff = workspace.diff;
      changedFiles = workspace.changedFiles;
    } else if (snapshot) {
      try {
        const { diff: raw, truncated } = await diffSince(workdir, snapshot, { maxBytes: MAX_DIFF_CHARS });
        diff = redact(raw) + (truncated ? '\n[diff truncated]' : '');
        const files = await changesSince(workdir, snapshot);
        changedFiles = files.map((f) => `- ${f.path} (${f.status}, ${f.origin === 'task' ? 'task change' : f.origin === 'both' ? 'task change on top of pre-existing user work' : 'pre-existing user work'})`).join('\n');
      } catch {
        diff = '(diff unavailable)';
      }
    } else {
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
      gitStatusText = workspace ? workspace.gitStatus : (await gitStatus(workdir)).slice(0, 80).map((e) => `${e.code} ${e.path}`).join('\n') || 'clean';
    } catch {
      gitStatusText = 'not a Git repository';
    }

    const verifyKinds = new Set(DEFAULT_VERIFY_COMMAND_KINDS);
    // Typed against the catalog: a placeholder the templates may use is always filled here.
    const vars: Record<PromptPlaceholder, string> = {
      task_id: task.id,
      title: task.title,
      role: ROLE_LABEL[def.role],
      stage_name: def.name,
      workflow_name: task.workflow.name,
      request: `# ${task.title}\n\n${task.description}`,
      repository_name: workspace ? units.map((u) => u.repo.name).join(', ') : repo.name,
      repository_path: workspace ? agentWorkdir(task, repo) : workdir,
      repository_facts: workspace ? workspace.facts : this.repositoryFacts(repo, task),
      git_status: gitStatusText,
      investigation: await this.artifactsOf(task.id, ['investigation']),
      plan: await this.latest(task.id, 'plan'),
      implementation_report: await this.artifactsOf(task.id, ['implementation-report', 'fix-report'], 20_000),
      review: await this.latest(task.id, 'review'),
      test_results: this.testResults(task),
      verification_report: await this.latest(task.id, 'browser-report'),
      diff: clip(diff, MAX_DIFF_CHARS),
      changed_files: changedFiles,
      directives: this.directives(task, def, stage),
      attachments: await this.attachments(task),
      previous_attempt: this.previousAttempt(task, def, stage),
      verification_commands: workspace
        ? workspace.commands
        : repo.commands
            .filter((c) => c.enabled && verifyKinds.has(c.kind))
            .map((c) => `- ${COMMAND_KIND_LABEL[c.kind]}: \`${c.command}\``)
            .join('\n'),
      preexisting_changes: task.git.preexistingChanges.length ? task.git.preexistingChanges.join(', ') : 'none',
      fix_cycle: String(task.fixCycles),
      max_fix_cycles: String(task.maxFixCycles),
    };
    const header = `Task: ${task.id}\nRole: ${def.role}\nStage: ${def.key}\nWorking directory: ${path.resolve(workspace ? agentWorkdir(task, repo) : workdir)}\n\n${RUN_CONTEXT}\n\n`;
    const guidance = this.guidance(task.id);
    // Chairman guidance follows the role template so user-edited templates still receive it.
    const supervisor = guidance ? `\n\n## Chairman guidance (supervisor of this task)\n\n${guidance}\n` : '';
    let lessons = '';
    try {
      lessons = this.lessons(task, def, stage);
    } catch {
      /* advice is optional: a prompt never fails for want of it */
    }
    const tools = await this.toolSections(task, def, repo).catch(() => '');
    return { prompt: header + renderTemplate(template.body, vars) + supervisor + lessons + tools, templateVersion: template.version };
  }
}
