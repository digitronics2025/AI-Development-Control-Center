import { AgentGuardError } from '@acc/agent-sdk';
import { runShell, type ProcessResult } from '@acc/executor';
import { changesSince, commitPaths, committableTree } from '@acc/git';
import { alwaysRequiresApproval, classifyCommand, redact, sanitizeEnv } from '@acc/security';
import {
  COMMAND_KIND_LABEL,
  DEFAULT_VERIFY_COMMAND_KINDS,
  ERROR_CLASS_LABEL,
  ROLE_ACTIVITY,
  type ArtifactType,
  type CommandKind,
  type ErrorClass,
  type EventType,
  type ExecutionStatus,
  type Role,
  type StageDefinition,
  type StageInstance,
  type TestRun,
  type RepositoryCommand,
} from '@acc/shared';
import type { RepairPlan, RepairStrategy } from '@acc/tools';
import type { Bus } from '../bus.js';
import type { AgentRegistry } from '../services/agents.js';
import type { ReleaseService } from '../release/service.js';
import { summaryLine } from '../release/service.js';
import type { ArtifactService } from '../services/artifacts.js';
import type { SettingsService } from '../services/settings.js';
import { newId, now, type RepositoryRecord, type Store, type TaskRecord } from '../store/store.js';
import type { ApprovalGate } from './approvals.js';
import type { BaselineChecks, Classification } from './baseline-checks.js';
import type { ContextBuilder, PromptCoverage } from './context.js';
import { LogSink } from './log-sink.js';
import { extractOperatorBlockers } from './report.js';
import { expandPackageScripts } from './script-resolve.js';
import type { Publisher } from './publisher.js';
import { FailureIdCollector, testFailureSummary, testPassSummary } from './test-summary.js';
import type { EngineTooling } from './tooling.js';
import { agentWorkdir, inFolder, taskRepositories } from './task-repositories.js';
import { taskWorkdir } from './workdir.js';

/** redirect = stop and apply a new plan (Chairman or user redirect); watchdog = stuck or dead worker. */
export type StopReason = 'pause' | 'cancel' | 'reroute' | 'shutdown' | 'redirect' | 'watchdog';

export type StageOutcome =
  | { kind: 'success'; stageId: string }
  | { kind: 'skipped'; stageId: string; testsSkipped?: boolean }
  | { kind: 'verdict_fail'; stageId: string }
  | { kind: 'tests_failed'; stageId: string; message: string }
  /**
   * An optional stage failed: a report limitation, never a recovery (AUTOPILOT_GATES_PLAN §3.D).
   * `limitation` replaces the default "<stage> (optional) failed: <message>" wording.
   */
  | { kind: 'optional_failed'; stageId: string; message: string; limitation?: string }
  | { kind: 'error'; stageId: string; errorClass: ErrorClass; message: string }
  | { kind: 'blocked'; stageId: string }
  /** A work stage needs the operator's decision before the task can be done right. */
  | { kind: 'needs_operator'; stageId: string; questions: string[] }
  | { kind: 'stopped'; stageId: string; reason: StopReason };

/** What a `redirect` stop applies once the loop has let go of the task. */
export interface RedirectPlan {
  patch: Partial<TaskRecord>;
  /** Status given to the stage that was running. */
  stageStatus: 'CANCELLED' | 'PAUSED';
  summary: string;
  event: { type: EventType; message: string; data?: Record<string, unknown> };
  /** Cancel pending approvals (the task is leaving the stage that asked). */
  withdrawApprovals: boolean;
  applied: boolean;
}

/** Per-task control block shared between the engine loop and user commands. */
export interface RunControl {
  stopReason: StopReason | null;
  cancelCurrent: (() => Promise<void>) | null;
  autoRetries: Map<string, number>;
  redirect: RedirectPlan | null;
  watchdogReason: string | null;
}

/** The report artifact each role writes, and the name its rendered prompt is saved under (docs/systems/prompts.md). */
const ROLE_ARTIFACT: Partial<Record<Role, { type: ArtifactType; name: string; prompt: string }>> = {
  investigator: { type: 'investigation', name: 'investigation.md', prompt: 'investigation-prompt.md' },
  planner: { type: 'plan', name: 'plan.md', prompt: 'plan-prompt.md' },
  implementer: { type: 'implementation-report', name: 'implementation-report.md', prompt: 'implementation-prompt.md' },
  fixer: { type: 'fix-report', name: 'fix-report.md', prompt: 'fix-prompt.md' },
  reviewer: { type: 'review', name: 'review.md', prompt: 'review-prompt.md' },
  verifier: { type: 'verification', name: 'verification.md', prompt: 'verification-prompt.md' },
};

/**
 * Changed files a report fails to account for (docs/plans/AUTOPILOT_GATES_PLAN.md §3.A):
 * each required path must appear in full, or by its basename when no other
 * changed file shares it.
 */
export function unreviewedFiles(output: string, coverage: PromptCoverage): string[] {
  const text = output.replace(/\\/g, '/');
  const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  const counts = new Map<string, number>();
  for (const p of new Set([...coverage.all, ...coverage.required])) counts.set(base(p), (counts.get(base(p)) ?? 0) + 1);
  return coverage.required.filter((p) => !text.includes(p) && !(counts.get(base(p)) === 1 && text.includes(base(p))));
}

/** Last `VERDICT: PASS|FAIL` line in an agent's output. */
export function parseVerdict(output: string): 'PASS' | 'FAIL' | null {
  const matches = [...output.matchAll(/VERDICT:\s*\**\s*(PASS|FAIL)\b/gi)];
  const last = matches.at(-1)?.[1];
  return last ? (last.toUpperCase() as 'PASS' | 'FAIL') : null;
}

const SUMMARY_LABEL = /^(summary|goal|findings)$/i;

/** A Markdown line reduced to plain prose, or null when it is structure rather than content. */
function proseLine(raw: string): { text: string; label: string | null } | null {
  const line = raw.trim();
  if (!line || line.startsWith('|') || /^(-{3,}|\*{3,}|_{3,}|```)/.test(line)) return null;
  const heading = /^#{1,6}\s+(.*)$/.exec(line)?.[1] ?? /^\*\*([^*]+?)\*\*:?$/.exec(line)?.[1];
  const text = (heading ?? line)
    .replace(/^(?:[>*+-]|\d+[.)])\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\d+[.)]\s*/, '')
    .trim();
  if (heading !== undefined) return { text, label: text.replace(/:$/, '') };
  // A bare "Summary: text" label line carries its own content.
  const inline = /^(summary|goal)\s*:\s*(.+)$/i.exec(text);
  if (inline) return { text: inline[2]!, label: null };
  if (text.length <= 3 || /^verdict:\s*(pass|fail)\.?$/i.test(text) || /^cause:\s*(code|plan)\.?$/i.test(text)) return null;
  return { text, label: null };
}

/**
 * One line describing an agent's result, for timelines and reports: the first
 * prose line under a Summary (or Goal/Findings) heading when there is one,
 * otherwise the first prose line that is not a heading, table or verdict.
 */
export function summarize(output: string, max = 240): string | null {
  const lines = output.split('\n').map(proseLine).filter((l) => l !== null);
  const labelled = lines.findIndex((l) => l.label !== null && SUMMARY_LABEL.test(l.label));
  const after = labelled === -1 ? undefined : lines.slice(labelled + 1).find((l) => l.label === null);
  const line = (after ?? lines.find((l) => l.label === null))?.text;
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The repository's enabled commands a tests/command stage would run. A tests
 * stage also runs `extraKinds`: checks the user or the Chairman asked for.
 */
export function stageCommands(def: StageDefinition, repo: RepositoryRecord, extraKinds: readonly CommandKind[] = []) {
  const kinds = new Set([...(def.commandKinds ?? DEFAULT_VERIFY_COMMAND_KINDS), ...(def.kind === 'tests' ? extraKinds : [])]);
  return repo.commands.filter((c) => c.enabled && kinds.has(c.kind));
}

/**
 * Check kinds the operator waived for this task (AUTOPILOT_GATES_PLAN §3.C):
 * set only through the operator's own directive route, never by an agent or the Chairman.
 */
export function waivedKinds(store: Store, taskId: string): Set<CommandKind> {
  const kinds = new Set<CommandKind>();
  for (const d of store.listDirectives(taskId)) if (d.state === 'active' && d.rule?.type === 'waive_check') for (const k of d.rule.kinds) kinds.add(k);
  return kinds;
}

/** Check kinds active directives require (e.g. "run E2E before finishing"). */
export function requiredKinds(store: Store, taskId: string): CommandKind[] {
  const kinds = new Set<CommandKind>();
  for (const d of store.listDirectives(taskId)) if (d.state === 'active' && d.rule?.type === 'require_check') for (const k of d.rule.kinds) kinds.add(k);
  return [...kinds];
}

/**
 * An optional command stage with nothing configured is skipped, so it must
 * never ask for approval. `repos` is every repository the task works in.
 */
export function skipsForLackOfCommands(def: StageDefinition, repos: RepositoryRecord | RepositoryRecord[]): boolean {
  const all = Array.isArray(repos) ? repos : [repos];
  if (def.kind === 'verify') return !all.some((r) => r.runtime.devUrl);
  return def.kind === 'command' && def.optional && all.every((r) => stageCommands(def, r).length === 0);
}

/**
 * Where a task's engine-run work happens, one entry per repository: for a
 * single-repository task exactly one, with no folder, so names and messages
 * read as they always did (docs/plans/MULTI_REPO_TASKS_PLAN.md).
 */
interface RepoUnit {
  repo: RepositoryRecord;
  workdir: string;
  /** The repository's folder in the task workspace; null for a single-repository task. */
  folder: string | null;
  git: TaskRecord['git'];
}

/** "web · test" in a multi-repository task, plain "test" otherwise. */
const unitLabel = (unit: Pick<RepoUnit, 'folder'>, name: string): string => (unit.folder ? `${unit.folder} · ${name}` : name);

export interface RunnerDeps {
  store: Store;
  bus: Bus;
  publisher: Publisher;
  agents: AgentRegistry;
  artifacts: ArtifactService;
  context: ContextBuilder;
  settings: SettingsService;
  approvals: ApprovalGate;
  baseEnv: NodeJS.ProcessEnv;
  tooling: EngineTooling;
  baselines: BaselineChecks;
  release: ReleaseService;
}

/** One run of a repository command, as the tests stage and its repairs see it. */
interface CommandRun {
  executionId: string;
  result: ProcessResult;
  passed: boolean;
  summary: string | null;
  tail: string[];
  /** Failing test ids read from the whole output (§3.B). */
  failures: string[];
  /** More tests failed than the collector keeps: the list is incomplete. */
  overflow: boolean;
}

export class StageRunners {
  constructor(private readonly d: RunnerDeps) {}

  private finishExecution(executionId: string, status: ExecutionStatus, fields: { exitCode?: number | null; errorClass?: ErrorClass | null; errorMessage?: string | null; startedAt: string }): void {
    const finishedAt = now();
    const execution = this.d.store.updateExecution(executionId, {
      status,
      exitCode: fields.exitCode ?? null,
      errorClass: fields.errorClass ?? null,
      errorMessage: fields.errorMessage ? redact(fields.errorMessage) : null,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(fields.startedAt).getTime(),
    });
    // Published so open log views update their status line.
    this.d.bus.publish({ type: 'execution', execution });
  }

  private publishExecution(id: string): void {
    const execution = this.d.store.getExecution(id);
    if (execution) this.d.bus.publish({ type: 'execution', execution });
  }

  // ---------------------------------------------------------------------------
  // Agent stages
  // ---------------------------------------------------------------------------

  async runAgent(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl): Promise<StageOutcome> {
    const { store, publisher, agents } = this.d;
    const agentId = stage.agentId!;
    const agentName = agents.has(agentId) ? agents.adapter(agentId).displayName : agentId;

    if (!agents.has(agentId)) {
      return this.failStage(stage, 'PERMISSION_DENIED', `Agent "${agentId}" is not installed in this orchestrator. Reroute the stage to another agent.`);
    }
    if (!agents.isEnabled(agentId)) {
      return this.failStage(stage, 'PERMISSION_DENIED', `${agentName} is disabled in Settings → Agents & Models. Enable it or reroute the stage.`);
    }

    // Directives are applied at this safe boundary: they are part of the prompt from here on.
    const applied = store.markDirectivesApplied(task.id, def.key);
    for (const directive of applied) {
      this.d.bus.publish({ type: 'directive', directive });
    }
    if (applied.length) publisher.event(task.id, 'DIRECTIVE_APPLIED', `${applied.length} directive${applied.length > 1 ? 's' : ''} applied to ${def.name}`, { count: applied.length }, stage.id);

    let prompt: string;
    let coverage: PromptCoverage;
    try {
      const built = await this.d.context.build(task, def, stage);
      prompt = built.prompt;
      coverage = built.coverage;
      store.updateTask(task.id, { promptVersions: { ...task.promptVersions, [def.role]: built.templateVersion } });
    } catch (error) {
      return this.failStage(stage, 'CONTEXT_FAILURE', `Context could not be built: ${(error as Error).message}`);
    }
    // What the agent actually read, kept per stage so any run can be debugged from its prompt.
    await this.d.artifacts.write(task.id, { name: ROLE_ARTIFACT[def.role]?.prompt ?? `${def.key}-prompt.md`, type: 'stage-output', content: prompt, stageId: stage.id, stageKey: def.key });

    const first = await this.executeAgent(task, def, stage, repo, control, prompt, agentName);
    if ('kind' in first) return first;
    let { output } = first;
    const artifact = ROLE_ARTIFACT[def.role] ?? { type: 'stage-output' as const, name: `${def.key}.md` };
    await this.d.artifacts.write(task.id, { name: artifact.name, type: artifact.type, content: output, stageId: stage.id, stageKey: def.key });

    if (def.role !== 'reviewer' && def.role !== 'verifier') {
      // Reviewers and verifiers list operator items without stopping (NEEDS OPERATOR); a work stage that cannot proceed stops the task.
      const questions = extractOperatorBlockers(output);
      if (questions.length) {
        publisher.updateStage(stage.id, { status: 'PAUSED', summary: summarize(output), finishedAt: now() });
        return { kind: 'needs_operator', stageId: stage.id, questions };
      }
    }

    let verdict: 'PASS' | 'FAIL' | null = null;
    if (def.verdict) {
      verdict = parseVerdict(output);
      if (!verdict) {
        return this.failStage(stage, 'UNKNOWN', `${agentName} did not end its ${def.name.toLowerCase()} with "VERDICT: PASS" or "VERDICT: FAIL"`);
      }
      // A PASS counts only when it accounts for every changed file the diff did not show (§3.A).
      // A FAIL is never second-guessed: it goes to the fix route as it is.
      const missing = verdict === 'PASS' ? unreviewedFiles(output, coverage) : [];
      if (missing.length) {
        const names = missing.slice(0, 20).join(', ') + (missing.length > 20 ? `, and ${missing.length - 20} more` : '');
        publisher.event(task.id, 'STAGE_RETRY', `${def.name} passed without accounting for ${missing.length} changed file${missing.length === 1 ? '' : 's'} the diff did not show (${names}); asking ${agentName} once more`, { missing }, stage.id);
        const followUp = [
          prompt,
          '',
          '## Coverage follow-up (from the orchestrator)',
          '',
          `Your previous report ended with VERDICT: PASS but did not account for these changed files, which the diff above does not show in full:`,
          '',
          ...missing.map((p) => `- ${p}`),
          '',
          'Read each of them from disk now (the Diff coverage section shows how). Then write your complete report again, with a `## Files reviewed` section naming every one of them and what you found, and end with the VERDICT line. If one of them changes your verdict, say so.',
          '',
          'Your previous report, for reference:',
          '',
          output.length > 20_000 ? `${output.slice(0, 20_000)}\n[previous report truncated]` : output,
        ].join('\n');
        const second = await this.executeAgent(task, def, stage, repo, control, followUp, agentName);
        if ('kind' in second) return second;
        output = second.output;
        await this.d.artifacts.write(task.id, { name: artifact.name, type: artifact.type, content: output, stageId: stage.id, stageKey: def.key });
        verdict = parseVerdict(output);
        if (!verdict) return this.failStage(stage, 'UNKNOWN', `${agentName} did not end its ${def.name.toLowerCase()} with "VERDICT: PASS" or "VERDICT: FAIL"`);
        const still = verdict === 'PASS' ? unreviewedFiles(output, coverage) : [];
        if (still.length) {
          return this.failStage(stage, 'REVIEW_INCOMPLETE', `${def.name} gave PASS twice without reviewing ${still.length} changed file${still.length === 1 ? '' : 's'} the diff did not show: ${still.slice(0, 20).join(', ')}${still.length > 20 ? ', …' : ''}`);
        }
      }
    } else if (def.role === 'reviewer' || def.role === 'verifier') {
      // Advisory verdict: recorded for the report, but it does not route the
      // workflow (a review-only workflow completes and says changes were requested).
      verdict = parseVerdict(output);
    }
    publisher.updateStage(stage.id, { status: 'SUCCESS', verdict, summary: summarize(output), finishedAt: now() });
    if (verdict === 'FAIL') {
      publisher.event(task.id, 'REVIEW_FAILED', `${def.name} requested changes`, { verdict }, stage.id);
      if (def.verdict) return { kind: 'verdict_fail', stageId: stage.id };
    }
    if (verdict === 'PASS') publisher.event(task.id, 'REVIEW_PASSED', `${def.name} passed`, { verdict }, stage.id);
    publisher.event(task.id, 'STAGE_COMPLETED', `${def.name} completed`, { durationMs: first.durationMs }, stage.id);
    return { kind: 'success', stageId: stage.id };
  }

  /**
   * One run of the stage's agent with `prompt`, as its own execution with its
   * own log. Returns the redacted output, or the outcome that ends the stage
   * (stopped, failed, empty output).
   */
  private async executeAgent(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl, prompt: string, agentName: string): Promise<{ output: string; durationMs: number } | StageOutcome> {
    const { store, publisher, agents } = this.d;
    const agentId = stage.agentId!;
    const executionId = newId();
    const startedAt = now();
    const workdir = agentWorkdir(task, repo);
    store.insertExecution({
      id: executionId,
      taskId: task.id,
      stageId: stage.id,
      kind: 'agent',
      agentId,
      model: stage.model,
      effort: stage.effort,
      command: agentId,
      cwd: workdir,
      status: 'running',
      exitCode: null,
      errorClass: null,
      errorMessage: null,
      pid: null,
      startedAt,
      finishedAt: null,
      durationMs: null,
    });
    this.publishExecution(executionId);
    const sink = new LogSink(store, this.d.bus, task.id, executionId);
    const adapter = agents.adapter(agentId);

    // The Control Center's tools, over MCP, scoped to this stage (docs/plans/tool-layer-v2).
    const bridge = this.d.tooling.openAgentSession(task, def, stage, repo);
    if (bridge) sink.push('system', 'Control Center tools available to this run (MCP server "acc")');
    let handle;
    try {
      handle = await agents.launch(agentId, {
        ...agents.runtimeOptions(agentId),
        executionId,
        cwd: workdir,
        prompt,
        model: stage.model ?? 'default',
        effort: stage.effort ?? 'default',
        permissionLevel: def.permissionLevel,
        timeoutMs: def.timeoutSec * 1000,
        onLine: sink.push,
        toolBridge: bridge ? { name: 'acc', command: bridge.command, args: bridge.args, env: bridge.env } : undefined,
        pluginDirs: await this.d.context.pluginDirs(task).catch(() => []),
      }, {
        origin: 'stage',
        projectId: task.repositoryId,
        taskId: task.id,
        runId: stage.id,
        workflowId: task.workflowId,
        workflowStep: def.key,
        agentRole: def.role,
        mode: task.mode,
      });
    } catch (error) {
      bridge?.close();
      const errorClass: ErrorClass = error instanceof AgentGuardError ? error.errorClass : 'PROCESS_CRASH';
      const message = (error as Error).message;
      sink.push('system', message);
      sink.flush();
      this.finishExecution(executionId, 'failed', { errorClass, errorMessage: message, startedAt });
      return this.failStage(stage, errorClass, message);
    }

    store.updateExecution(executionId, { command: redact(handle.commandLine), pid: handle.pid });
    this.publishExecution(executionId);
    control.cancelCurrent = () => adapter.cancel(executionId);
    // A stop requested while the launch was in flight takes effect now.
    if (control.stopReason) void adapter.cancel(executionId);
    publisher.updateStage(stage.id, { status: 'RUNNING' });
    publisher.event(task.id, 'AGENT_STARTED', `${agentName} started ${ROLE_ACTIVITY[def.role].toLowerCase()}`, { agentId, model: stage.model, effort: stage.effort }, stage.id);

    const result = await handle.done.finally(() => bridge?.close());
    control.cancelCurrent = null;
    sink.flush();

    if (result.status === 'cancelled') {
      this.finishExecution(executionId, 'cancelled', { exitCode: result.exitCode, startedAt });
      return { kind: 'stopped', stageId: stage.id, reason: control.stopReason ?? 'cancel' };
    }
    if (result.status !== 'succeeded') {
      const errorClass = result.errorClass ?? 'UNKNOWN';
      this.finishExecution(executionId, result.status === 'timed_out' ? 'timed_out' : 'failed', {
        exitCode: result.exitCode,
        errorClass,
        errorMessage: result.errorMessage,
        startedAt,
      });
      return this.failStage(stage, errorClass, result.errorMessage ?? ERROR_CLASS_LABEL[errorClass]);
    }

    this.finishExecution(executionId, 'succeeded', { exitCode: result.exitCode, startedAt });
    const output = redact(result.output);
    if (!output.trim()) {
      return this.failStage(stage, 'UNKNOWN', `${agentName} finished without producing any output`);
    }
    return { output, durationMs: result.durationMs };
  }

  // ---------------------------------------------------------------------------
  // Tests / command stages
  // ---------------------------------------------------------------------------

  async runCommands(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl): Promise<StageOutcome> {
    const { store, publisher, approvals } = this.d;
    const extra = [...task.extraCheckKinds, ...requiredKinds(store, task.id)];
    // The operator's per-task waivers (AUTOPILOT_GATES_PLAN §3.C) apply to the tests stage only; a waiver
    // is the later operator decision, so it wins over a directive that requires the same kind.
    const waived = def.kind === 'tests' ? waivedKinds(store, task.id) : new Set<CommandKind>();
    const kinds = new Set([...(def.commandKinds ?? DEFAULT_VERIFY_COMMAND_KINDS), ...(def.kind === 'tests' ? extra : [])].filter((k) => !waived.has(k)));
    // Every repository runs its own commands in its own folder.
    const units = this.units(task, repo);
    const repoNames = units.map((u) => u.repo.name).join(', ');
    const configured = units.flatMap((unit) => stageCommands(def, unit.repo, extra).map((command) => ({ unit, command, name: unitLabel(unit, command.name) })));
    const jobs = configured.filter((j) => !waived.has(j.command.kind));
    const commands = jobs.map((j) => j.command);
    // One-shot requests are consumed by the stage that runs them.
    if (def.kind === 'tests' && task.extraCheckKinds.length) store.updateTask(task.id, { extraCheckKinds: [] });
    const skippedByWaiver = [...new Set(configured.filter((j) => waived.has(j.command.kind)).map((j) => j.command.kind))];
    if (skippedByWaiver.length) {
      const conflict = skippedByWaiver.filter((k) => extra.includes(k));
      publisher.event(
        task.id,
        'TEST_STARTED',
        `${def.name}: not gating this task on ${skippedByWaiver.map((k) => COMMAND_KIND_LABEL[k].toLowerCase()).join(', ')} (your directive)${conflict.length ? `; ${conflict.join(', ')} ${conflict.length === 1 ? 'was' : 'were'} also required, and your later waiver wins` : ''}`,
        { waived: skippedByWaiver, conflict },
        stage.id,
      );
    }

    if (commands.length === 0 && configured.length > 0) {
      // Everything configured was waived: the operator decided, so nothing asks again.
      publisher.updateStage(stage.id, { status: 'SKIPPED', summary: 'Every configured check is waived for this task by your directive', finishedAt: now() });
      publisher.event(task.id, 'STAGE_SKIPPED', `${def.name} skipped: every configured check is waived for this task`, {}, stage.id);
      return { kind: 'skipped', stageId: stage.id, testsSkipped: true };
    }
    if (commands.length === 0) {
      const wanted = [...kinds].map((k) => COMMAND_KIND_LABEL[k].toLowerCase()).join(', ');
      if (def.kind === 'command' && def.optional) {
        publisher.updateStage(stage.id, { status: 'SKIPPED', summary: `No ${wanted} command configured`, finishedAt: now() });
        publisher.event(task.id, 'STAGE_SKIPPED', `${def.name} skipped: no ${wanted} command configured for ${repoNames}`, {}, stage.id);
        return { kind: 'skipped', stageId: stage.id };
      }
      if (def.kind === 'tests') {
        const gate = approvals.state(task.id, 'skip_tests', { stageKey: def.key });
        if (gate === 'approved') {
          publisher.updateStage(stage.id, { status: 'SKIPPED', summary: 'Skipped with approval — no verification commands configured', finishedAt: now() });
          publisher.event(task.id, 'STAGE_SKIPPED', `${def.name} skipped with your approval; the change is not verified by tests`, {}, stage.id);
          return { kind: 'skipped', stageId: stage.id, testsSkipped: true };
        }
        publisher.updateStage(stage.id, { status: 'WAITING_APPROVAL', summary: 'No verification commands configured' });
        const pending = approvals.pending(task.id, 'skip_tests', { stageKey: def.key });
        if (pending) approvals.park(task, pending);
        else
          approvals.request(task, {
            kind: 'skip_tests',
            stageId: stage.id,
            stageKey: def.key,
            requestedBy: 'system',
            action: 'Continue without verification commands',
            permissionLevel: def.permissionLevel,
            risk: 'elevated',
            reason: `${repoNames} ${units.length > 1 ? 'have' : 'has'} no enabled ${wanted} commands, so the change cannot be verified.`,
            riskExplanation: 'Approving lets the task continue without tests; its report will say it is unverified. Prefer adding commands in Repositories → Commands, then Retry stage.',
            environment: repo.path,
          });
        return { kind: 'blocked', stageId: stage.id };
      }
      return this.failStage(stage, 'COMMAND_FAILURE', `No ${wanted} command is configured for ${repoNames}`);
    }

    // Classify every command before running any of them.
    for (const job of jobs) {
      const blocked = this.gateCommand(task, def, stage, job.unit.repo, job.name, job.command.command, job.unit.workdir);
      if (blocked) return blocked;
    }

    const runs: TestRun[] = jobs.map(({ unit, command: c, name }) => ({
      id: newId(),
      taskId: task.id,
      stageId: stage.id,
      executionId: null,
      name,
      ...(unit.folder ? { repositoryId: unit.repo.id } : {}),
      kind: c.kind,
      command: redact(c.command),
      status: 'not_run',
      exitCode: null,
      durationMs: null,
      summary: null,
      startedAt: null,
      finishedAt: null,
    }));
    for (const run of runs) {
      store.insertTestRun(run);
      this.publishTestRun(run);
    }
    publisher.updateStage(stage.id, { status: 'RUNNING' });
    publisher.event(task.id, 'TEST_STARTED', `${def.name} started: ${jobs.map((j) => j.name).join(', ')}`, { count: commands.length }, stage.id);

    const { env } = sanitizeEnv(this.d.baseEnv, this.d.settings.get().billingMode);
    const report: string[] = [];
    let failure: string | null = null;
    let finished = 0;
    const preexisting: string[] = [];
    let reused = 0;
    // The files each repository's commands run on (§3.E), read once and again only after a command changed them.
    const trees = new Map<string, string | null>();
    const treeOf = async (workdir: string, fresh = false): Promise<string | null> => {
      if (!fresh && trees.has(workdir)) return trees.get(workdir)!;
      const tree = await committableTree(workdir).catch(() => null);
      trees.set(workdir, tree);
      return tree;
    };

    for (let i = 0; i < jobs.length; i++) {
      const { command, unit, name } = jobs[i]!;
      const { workdir } = unit;
      const run = runs[i]!;
      if (control.stopReason) break;
      const treeId = await treeOf(workdir);

      // The same command already passed on exactly these files in this task: that result stands (§3.E).
      const earlier = treeId ? this.reusablePass(task.id, treeId, run) : null;
      if (earlier) {
        const at = earlier.finishedAt ? earlier.finishedAt.slice(11, 19) : 'earlier';
        const earlierStage = earlier.stageId ? (store.getStage(earlier.stageId)?.name ?? 'an earlier stage') : 'an earlier stage';
        const summary = `Reused: same files as ${earlierStage} at ${at}`;
        this.publishTestRun(store.updateTestRun(run.id, { status: 'passed', exitCode: 0, durationMs: 0, summary, startedAt: now(), finishedAt: now(), treeId, reusedFrom: earlier.id }));
        report.push(`✓ ${name.padEnd(16)} 0.0s   ${summary}`);
        publisher.event(task.id, 'TEST_PASSED', `${name} passed (reused: nothing changed since ${earlierStage} at ${at})`, { reusedFrom: earlier.id }, stage.id);
        finished++;
        reused++;
        continue;
      }
      this.publishTestRun(store.updateTestRun(run.id, { status: 'running', startedAt: now(), treeId }));

      // Run it; when it fails for a reason that is the environment's fault
      // (missing dependency, port held by this task, network hiccup, file
      // lock), repair and run it again — a bounded number of times.
      const attempted: RepairStrategy[] = [];
      const repairs: string[] = [];
      let exec = await this.executeCommand(task, stage, workdir, command, env, control, run);
      while (exec && !exec.passed && !exec.result.cancelled && !control.stopReason) {
        const classified = this.d.tooling.classify(exec.tail, exec.result.timedOut);
        // A repair that fails hands over to the next strategy (a locked install, then a normal one).
        let repaired = false;
        for (let plan = this.d.tooling.plan(classified, workdir, attempted); plan && !control.stopReason; plan = this.d.tooling.plan(classified, workdir, attempted)) {
          attempted.push(plan.strategy);
          const row = this.d.tooling.recordRepair(task, stage.id, command.command, classified, plan, attempted.length);
          const result = await this.applyRepair(task, stage, unit.repo, workdir, plan, env, control);
          this.d.tooling.finishRepair(row.id, result.ok, result.detail);
          if (result.ok) {
            repairs.push(plan.description.replace(/, then run it again$/, ''));
            repaired = true;
            break;
          }
        }
        if (!repaired) break;
        exec = await this.executeCommand(task, stage, workdir, command, env, control, run);
      }
      if (!exec || exec.result.cancelled) {
        this.publishTestRun(store.updateTestRun(run.id, { status: 'not_run', summary: 'Stopped', finishedAt: now(), durationMs: exec?.result.durationMs ?? null }));
        return { kind: 'stopped', stageId: stage.id, reason: control.stopReason ?? 'cancel' };
      }
      // A command that changed the files (a formatter, a code generator) ran on a tree that no longer exists: not reusable.
      const after = await treeOf(workdir, true);
      const repairedNote = repairs.length ? ` (after repair: ${repairs.join('; ')})` : '';
      let summary = exec.passed && repairs.length ? `${exec.summary ?? 'Passed'}${repairedNote}` : exec.summary;
      const failures = exec.passed ? null : exec.failures.map((f) => redact(f));

      // A failure is compared with the baseline commit before it may block (§3.B).
      let verdict: Classification | null = null;
      if (!exec.passed && def.kind === 'tests' && unit.repo.preexistingFailures !== 'block' && !control.stopReason) {
        this.publishTestRun(store.updateTestRun(run.id, { summary: `${summary ?? 'Failed'} — checking the baseline commit` }));
        verdict = await this.d.baselines.classify(
          { task, stage, repo: unit.repo, baselineCommit: unit.git.baselineCommit, command, env, failures: failures ?? [], overflow: exec.overflow },
          { stopped: () => control.stopReason !== null },
        );
        if (verdict.classification === 'preexisting') summary = `${summary ?? 'Failed'} — all ${failures!.length} failing as before on ${verdict.baselineCommit!.slice(0, 7)}`;
      }
      this.publishTestRun(
        store.updateTestRun(run.id, {
          status: exec.passed ? 'passed' : 'failed',
          exitCode: exec.result.exitCode,
          durationMs: exec.result.durationMs,
          summary: summary ? redact(summary) : null,
          finishedAt: now(),
          failures,
          classification: verdict?.classification ?? null,
          treeId: exec.passed && after === treeId ? treeId : exec.passed ? null : treeId,
        }),
      );
      finished++;
      report.push(`${exec.passed ? '✓' : '✕'} ${name.padEnd(16)} ${(exec.result.durationMs / 1000).toFixed(1)}s${summary ? `   ${summary}` : ''}`);
      if (exec.passed) {
        publisher.event(task.id, 'TEST_PASSED', `${name} passed${repairedNote}`, { executionId: exec.executionId, durationMs: exec.result.durationMs }, stage.id);
      } else if (verdict?.classification === 'preexisting') {
        // Recorded and reported, never a fix cycle: the stage goes on with the next command.
        publisher.event(task.id, 'TEST_FAILED', `${name} failed as it already did before this task (${failures!.length} pre-existing failure${failures!.length === 1 ? '' : 's'} on ${verdict.baselineCommit!.slice(0, 7)}); not blocking`, { executionId: exec.executionId, classification: 'preexisting' }, stage.id);
        preexisting.push(name);
      } else {
        const why = verdict ? (verdict.classification === 'new' ? ' · new since the baseline' : ` · compared with the baseline: unknown (${verdict.reason ?? 'no result'}), treated as new`) : '';
        publisher.event(task.id, 'TEST_FAILED', `${name} failed${summary ? ` · ${summary}` : ''}${why}`, { executionId: exec.executionId, classification: verdict?.classification ?? null }, stage.id);
        report.push('', `Output of ${name} (last lines):`, ...exec.tail, '');
        failure = `${name} failed${summary ? `: ${summary}` : ''}`;
        break;
      }
    }
    for (const run of runs.slice(finished)) report.push(`○ ${run.name.padEnd(16)} not run`);
    // A stop between two commands is a stop, not a pass with commands missing.
    if (!failure && control.stopReason) return { kind: 'stopped', stageId: stage.id, reason: control.stopReason };

    if (def.kind === 'tests') {
      await this.d.artifacts.write(task.id, { name: 'tests.log', type: 'tests-log', content: report.join('\n'), stageId: stage.id, stageKey: def.key });
    }
    if (failure) {
      publisher.updateStage(stage.id, {
        status: 'FAILED',
        errorClass: def.kind === 'tests' ? 'TEST_FAILURE' : 'COMMAND_FAILURE',
        errorMessage: failure,
        summary: failure,
        finishedAt: now(),
      });
      // An optional stage (a staging deploy, a smoke test) that fails is reported, not repaired.
      if (def.optional) return { kind: 'optional_failed', stageId: stage.id, message: redact(failure) };
      publisher.event(task.id, 'STAGE_FAILED', `${def.name} failed: ${failure}`, {}, stage.id);
      return def.kind === 'tests'
        ? { kind: 'tests_failed', stageId: stage.id, message: failure }
        : { kind: 'error', stageId: stage.id, errorClass: 'COMMAND_FAILURE', message: failure };
    }
    const passed = commands.length - preexisting.length;
    const parts = [`${passed} command${passed === 1 ? '' : 's'} passed${reused ? ` (${reused} reused)` : ''}`];
    if (preexisting.length) parts.push(`${preexisting.join(', ')} failing as before this task`);
    publisher.updateStage(stage.id, { status: 'SUCCESS', summary: parts.join('; '), finishedAt: now() });
    publisher.event(task.id, 'STAGE_COMPLETED', `${def.name} passed${preexisting.length ? ` apart from failures that already existed before this task (${preexisting.join(', ')})` : ''}`, {}, stage.id);
    return { kind: 'success', stageId: stage.id };
  }

  /** A passing run of the same command, in the same repository, on the same files, earlier in this task (§3.E). */
  private reusablePass(taskId: string, treeId: string, run: TestRun): TestRun | null {
    try {
      return this.d.store.findReusableRun(taskId, treeId, run.command, run.repositoryId ?? null);
    } catch {
      // Reuse is only an optimisation: when the lookup fails, the command runs.
      return null;
    }
  }

  /**
   * Approval gate for one command the engine is about to run. Returns the
   * blocked outcome when the task must wait for a person, or null to go on.
   */
  private gateCommand(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, name: string, commandLine: string, workdir: string = taskWorkdir(task, repo)): StageOutcome | null {
    const { approvals, publisher } = this.d;
    const cls = classifyCommand(expandPackageScripts(workdir, commandLine));
    const autoLevel = this.d.tooling.autoApproveLevel(task, repo);
    const needs = alwaysRequiresApproval(cls) || (cls.level > def.permissionLevel && cls.level > autoLevel);
    if (!needs) return null;
    const shown = redact(commandLine);
    // A command that always needs a person (dangerous, Level 5, production) is approved for this
    // stage attempt only: a retry or a fix cycle asks again (audit F-09). Others hold for the task.
    const match = alwaysRequiresApproval(cls) ? { command: shown, stageId: stage.id } : { command: shown };
    const gate = approvals.state(task.id, 'command', match);
    if (gate === 'approved') return null;
    publisher.updateStage(stage.id, { status: 'WAITING_APPROVAL', summary: `Waiting for approval: ${shown}` });
    const pending = approvals.pending(task.id, 'command', match);
    if (pending) approvals.park(task, pending);
    else
      approvals.request(task, {
        kind: 'command',
        stageId: stage.id,
        stageKey: def.key,
        requestedBy: 'system',
        action: `Run "${name}"`,
        command: shown,
        permissionLevel: cls.level,
        risk: cls.risk,
        reason: `${def.name} runs a ${cls.risk} command: ${cls.reasons.join(', ')}.`,
        riskExplanation:
          cls.risk === 'dangerous'
            ? 'This command can destroy data or history. It runs only after you type the confirmation phrase.'
            : cls.production
              ? 'This command targets production.'
              : `Level ${cls.level} is above the stage's permission level ${def.permissionLevel}.`,
        environment: cls.production ? 'production' : repo.path,
      });
    return { kind: 'blocked', stageId: stage.id };
  }

  /** Run one repository command as an execution with its own log. Null when stopped before it started. */
  private async executeCommand(task: TaskRecord, stage: StageInstance, workdir: string, command: RepositoryCommand, env: NodeJS.ProcessEnv, control: RunControl, run: TestRun): Promise<CommandRun | null> {
    const { store, publisher } = this.d;
    if (control.stopReason) return null;
    const executionId = newId();
    const startedAt = now();
    store.insertExecution({
      id: executionId,
      taskId: task.id,
      stageId: stage.id,
      kind: 'command',
      agentId: null,
      model: null,
      effort: null,
      command: redact(command.command),
      cwd: workdir,
      status: 'running',
      exitCode: null,
      errorClass: null,
      errorMessage: null,
      pid: null,
      startedAt,
      finishedAt: null,
      durationMs: null,
    });
    this.publishExecution(executionId);
    this.publishTestRun(store.updateTestRun(run.id, { status: 'running', executionId }));
    publisher.event(task.id, 'COMMAND_STARTED', `Running ${command.name}`, { command: redact(command.command), executionId }, stage.id);

    const sink = new LogSink(store, this.d.bus, task.id, executionId);
    sink.push('system', `$ ${command.command}`);
    // Failing test ids come from the whole output as it streams, not only from the tail kept for the prompt.
    const collector = new FailureIdCollector();
    const handle = runShell({
      commandLine: command.command,
      cwd: workdir,
      env,
      timeoutMs: command.timeoutSec * 1000,
      onLine: (stream, line) => {
        sink.push(stream, line);
        collector.push(line);
      },
    });
    store.updateExecution(executionId, { pid: handle.pid });
    control.cancelCurrent = () => handle.cancel();
    if (control.stopReason) void handle.cancel();
    const result = await handle.done;
    control.cancelCurrent = null;
    sink.flush();

    if (result.cancelled) {
      this.finishExecution(executionId, 'cancelled', { exitCode: result.exitCode, startedAt });
      return { executionId, result, passed: false, summary: 'Stopped', tail: sink.recent(80), failures: [], overflow: false };
    }
    const passed = result.exitCode === 0 && !result.timedOut && !result.spawnError;
    const tail = sink.recent(80);
    const summary = passed
      ? testPassSummary(tail)
      : result.timedOut
        ? `Timed out after ${command.timeoutSec}s`
        : result.spawnError
          ? `Could not start: ${result.spawnError}`
          : testFailureSummary(tail);
    this.finishExecution(executionId, passed ? 'succeeded' : result.timedOut ? 'timed_out' : 'failed', {
      exitCode: result.exitCode,
      errorClass: passed ? null : result.timedOut ? 'TIMEOUT' : stage.kind === 'tests' ? 'TEST_FAILURE' : 'COMMAND_FAILURE',
      errorMessage: passed ? null : summary,
      startedAt,
    });
    return { executionId, result, passed, summary, tail, failures: passed ? [] : collector.list(), overflow: collector.overflow };
  }

  /** Carry out one repair; returns whether the command is worth running again. */
  private async applyRepair(task: TaskRecord, stage: StageInstance, repo: RepositoryRecord, workdir: string, plan: RepairPlan, env: NodeJS.ProcessEnv, control: RunControl): Promise<{ ok: boolean; detail: string }> {
    switch (plan.strategy) {
      case 'retry_after_backoff': {
        const until = Date.now() + (plan.delayMs ?? 2000);
        while (Date.now() < until && !control.stopReason) await new Promise((r) => setTimeout(r, 200));
        return { ok: !control.stopReason, detail: control.stopReason ? 'Stopped while waiting' : `Waited ${Math.round((plan.delayMs ?? 2000) / 1000)}s` };
      }
      case 'free_port':
        return this.d.tooling.freePort(task, repo, plan.port!);
      default: {
        const repairCommand: RepositoryCommand = { id: 'repair', name: plan.strategy === 'install_browser' ? 'install browser' : 'install dependencies', command: plan.command!, kind: 'other', enabled: true, timeoutSec: 1200 };
        const run: TestRun = { id: newId(), taskId: task.id, stageId: stage.id, executionId: null, name: repairCommand.name, kind: 'other', command: repairCommand.command, status: 'running', exitCode: null, durationMs: null, summary: null, startedAt: now(), finishedAt: null };
        this.d.store.insertTestRun(run);
        const exec = await this.executeCommand(task, stage, workdir, repairCommand, env, control, run);
        const ok = Boolean(exec?.passed);
        this.publishTestRun(this.d.store.updateTestRun(run.id, { status: ok ? 'passed' : exec ? 'failed' : 'not_run', exitCode: exec?.result.exitCode ?? null, durationMs: exec?.result.durationMs ?? null, summary: `Repair: ${plan.description}`, finishedAt: now() }));
        return { ok, detail: ok ? `${repairCommand.command} succeeded` : `${repairCommand.command} failed${exec?.summary ? `: ${exec.summary}` : ''}` };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Verify stages: the app, started and checked in a real browser (V2 plan §21)
  // ---------------------------------------------------------------------------

  async runVerify(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl): Promise<StageOutcome> {
    const { publisher } = this.d;
    const units = this.units(task, repo).filter((u) => u.repo.runtime.devUrl);
    if (!units.length) {
      const multi = this.units(task, repo).length > 1;
      publisher.updateStage(stage.id, { status: 'SKIPPED', summary: `No app runtime configured for ${multi ? 'these repositories' : 'this repository'}`, finishedAt: now() });
      publisher.event(task.id, 'STAGE_SKIPPED', `${def.name} skipped: set how to start the app in Repositories → ${repo.name} → Runtime to verify it in a browser`, {}, stage.id);
      return { kind: 'skipped', stageId: stage.id };
    }
    for (const unit of units) {
      if (!unit.repo.runtime.devCommand) continue;
      const blocked = this.gateCommand(task, def, stage, unit.repo, unitLabel(unit, 'start the app'), unit.repo.runtime.devCommand, unit.workdir);
      if (blocked) return blocked;
    }
    // Apps are started and checked one at a time; each is stopped before the next starts.
    const reports: string[][] = [];
    const passed: string[] = [];
    publisher.updateStage(stage.id, { status: 'RUNNING' });
    // One report for the stage, covering every app checked so far.
    const writeReport = () => this.d.artifacts.write(task.id, { name: 'browser-verification.md', type: 'browser-report', content: reports.map((l) => l.join('\n')).join('\n\n'), stageId: stage.id, stageKey: def.key });
    for (const unit of units) {
      const r = await this.verifyApp(task, def, stage, unit, control);
      reports.push(r.report);
      if (r.kind === 'stopped') return { kind: 'stopped', stageId: stage.id, reason: control.stopReason ?? 'cancel' };
      if (r.kind === 'failed') {
        await writeReport();
        publisher.updateStage(stage.id, { status: 'FAILED', errorClass: 'TEST_FAILURE', errorMessage: redact(r.message), summary: redact(r.message), finishedAt: now() });
        publisher.event(task.id, 'STAGE_FAILED', `${def.name} failed: ${r.message}`, {}, stage.id);
        return { kind: 'tests_failed', stageId: stage.id, message: redact(r.message) };
      }
      passed.push(r.summary);
    }
    await writeReport();
    publisher.updateStage(stage.id, { status: 'SUCCESS', summary: redact(passed.join(' · ')).slice(0, 240), finishedAt: now() });
    publisher.event(task.id, 'STAGE_COMPLETED', `${def.name} passed`, {}, stage.id);
    return { kind: 'success', stageId: stage.id };
  }

  /** Start one repository's app, check it with `verify.web`, stop it. */
  private async verifyApp(
    task: TaskRecord,
    def: StageDefinition,
    stage: StageInstance,
    unit: RepoUnit,
    control: RunControl,
  ): Promise<{ kind: 'passed'; summary: string; report: string[] } | { kind: 'failed'; message: string; report: string[] } | { kind: 'stopped'; report: string[] }> {
    const { store, publisher } = this.d;
    const repo = unit.repo;
    const runtime = repo.runtime as typeof repo.runtime & { devUrl: string };
    const label = unitLabel(unit, runtime.verifyMode === 'browser' ? 'Browser verification' : 'HTTP verification');
    const run: TestRun = { id: newId(), taskId: task.id, stageId: stage.id, executionId: null, name: label, ...(unit.folder ? { repositoryId: repo.id } : {}), kind: 'e2e', command: redact(runtime.devCommand ?? runtime.devUrl), status: 'running', exitCode: null, durationMs: null, summary: null, startedAt: now(), finishedAt: null };
    store.insertTestRun(run);
    this.publishTestRun(run);
    const executionId = newId();
    const startedAt = now();
    store.insertExecution({ id: executionId, taskId: task.id, stageId: stage.id, kind: 'tool', agentId: null, model: null, effort: null, command: `verify.web ${redact(runtime.devUrl)}`, cwd: unit.workdir, status: 'running', exitCode: null, errorClass: null, errorMessage: null, pid: null, startedAt, finishedAt: null, durationMs: null });
    this.publishExecution(executionId);
    this.publishTestRun(store.updateTestRun(run.id, { executionId }));
    publisher.event(task.id, 'VERIFICATION', `${label} started: ${runtime.verifyPaths.join(', ')} on ${runtime.devUrl}`, { executionId }, stage.id);

    const sink = new LogSink(store, this.d.bus, task.id, executionId);
    const controller = new AbortController();
    control.cancelCurrent = async () => controller.abort();
    if (control.stopReason) controller.abort();
    const outcome = await this.d.tooling.tools.invoke({
      capability: 'verify.web',
      input: { startCommand: runtime.devCommand ?? undefined, url: runtime.devUrl, paths: runtime.verifyPaths, readyTimeoutSec: runtime.readyTimeoutSec, mode: runtime.verifyMode },
      origin: 'engine',
      scope: this.d.tooling.scope(task, repo, { level: def.permissionLevel, stageId: stage.id, cwd: unit.workdir }),
      preApproved: true,
      signal: controller.signal,
      timeoutMs: def.timeoutSec * 1000,
      onLine: (stream, line) => sink.push(stream, line),
    });
    control.cancelCurrent = null;
    const r = outcome.result;
    for (const line of r.evidence ?? []) sink.push('system', `evidence: ${line}`);
    const problems = ((r.output as { problems?: string[] } | undefined)?.problems ?? []).slice(0, 40);
    for (const p of problems) sink.push('stderr', p);
    if (!r.ok && r.stdout) for (const line of r.stdout.split('\n').slice(-40)) sink.push('stdout', line);
    sink.flush();
    if (controller.signal.aborted && control.stopReason) {
      this.finishExecution(executionId, 'cancelled', { startedAt });
      this.publishTestRun(store.updateTestRun(run.id, { status: 'not_run', summary: 'Stopped', finishedAt: now() }));
      return { kind: 'stopped', report: [] };
    }
    const reportLines = [
      `# ${label}`,
      '',
      `- App: ${redact(runtime.devUrl)}${runtime.devCommand ? ` (started with \`${redact(runtime.devCommand)}\`)` : ''}`,
      `- Result: ${r.ok ? 'passed' : 'FAILED'} — ${r.summary}`,
      '',
      '## Evidence',
      '',
      ...(r.evidence ?? []).map((e) => `- ${e}`),
      ...(problems.length ? ['', '## Problems', '', ...problems.map((p) => `- ${p}`)] : []),
      ...(r.artifacts?.length ? ['', '## Screenshots', '', ...r.artifacts.map((a) => `- ${a.name}`)] : []),
    ];
    const durationMs = Date.now() - new Date(startedAt).getTime();
    this.finishExecution(executionId, r.ok ? 'succeeded' : 'failed', { exitCode: r.ok ? 0 : 1, errorClass: r.ok ? null : 'TEST_FAILURE', errorMessage: r.ok ? null : r.summary, startedAt });
    this.publishTestRun(store.updateTestRun(run.id, { status: r.ok ? 'passed' : 'failed', exitCode: r.ok ? 0 : 1, durationMs, summary: redact(r.summary).slice(0, 400), finishedAt: now() }));
    publisher.event(task.id, 'VERIFICATION', `${label} ${r.ok ? 'passed' : 'failed'}: ${r.summary}`, { executionId, ok: r.ok }, stage.id);
    if (!r.ok) return { kind: 'failed', message: `${label} failed: ${problems[0] ?? r.summary}`, report: reportLines };
    return { kind: 'passed', summary: unit.folder ? `${unit.folder}: ${r.summary}` : r.summary, report: reportLines };
  }

  // ---------------------------------------------------------------------------
  // Release stages (docs/plans/RELEASE_STAGE_PLAN.md)
  // ---------------------------------------------------------------------------

  /**
   * Send the task's tested commit live; the typed Level 5 approval was given
   * before the stage started. Only Live succeeds. Anything else is an optional
   * failure — a report limitation, never a fix cycle, a retry or a recovery:
   * trying a release again is the operator's decision (§3.5).
   */
  async runRelease(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, control: RunControl): Promise<StageOutcome> {
    const { publisher, release, store } = this.d;
    const skip = release.skipReason(task, repo);
    if (skip) {
      publisher.updateStage(stage.id, { status: 'SKIPPED', summary: skip, finishedAt: now() });
      publisher.event(task.id, 'STAGE_SKIPPED', `${def.name} skipped: ${skip}`, {}, stage.id);
      return { kind: 'skipped', stageId: stage.id };
    }
    publisher.updateStage(stage.id, { status: 'RUNNING' });
    const approval = store.findApproval(task.id, 'stage_permission', { stageKey: def.key });
    let record;
    try {
      record = await release.release(task.id, { via: 'stage', approvalId: approval?.status === 'approved' ? approval.id : null, stageId: stage.id, stopped: () => control.stopReason !== null });
    } catch (error) {
      const message = redact((error as Error)?.message ?? String(error)).slice(0, 300);
      publisher.updateStage(stage.id, { status: 'FAILED', errorClass: 'UNKNOWN', errorMessage: message, summary: message, finishedAt: now() });
      return { kind: 'optional_failed', stageId: stage.id, message, limitation: `The release did not run to the end: ${message}` };
    }
    const line = summaryLine(record);
    if (record.state === 'live') {
      publisher.updateStage(stage.id, { status: 'SUCCESS', summary: line, finishedAt: now() });
      publisher.event(task.id, 'STAGE_COMPLETED', `${def.name} completed: ${line}`, {}, stage.id);
      return { kind: 'success', stageId: stage.id };
    }
    // Stopped before anything was sent: a pause, not a result; the stage runs again (and asks again) on resume.
    if (record.state === 'refused' && !record.publishedAt && control.stopReason) return { kind: 'stopped', stageId: stage.id, reason: control.stopReason };
    publisher.updateStage(stage.id, { status: 'FAILED', errorClass: 'COMMAND_FAILURE', errorMessage: line, summary: line, finishedAt: now() });
    return { kind: 'optional_failed', stageId: stage.id, message: line, limitation: line };
  }

  // ---------------------------------------------------------------------------
  // Git checkpoint stages
  // ---------------------------------------------------------------------------

  async runGit(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord): Promise<StageOutcome> {
    const { store, publisher } = this.d;
    const units = this.units(task, repo)
      .map((unit) => ({ unit, baseline: unit.git.baselineSnapshotId ? store.getSnapshot(unit.git.baselineSnapshotId) : null }))
      .filter((u) => u.baseline);
    if (!units.length) {
      publisher.updateStage(stage.id, { status: 'SKIPPED', summary: 'Not a Git repository or no baseline recorded', finishedAt: now() });
      publisher.event(task.id, 'STAGE_SKIPPED', `${def.name} skipped: no Git baseline`, {}, stage.id);
      return { kind: 'skipped', stageId: stage.id };
    }
    let current: RepoUnit | null = null;
    try {
      const made: Array<{ commit: string; files: number; folder: string | null }> = [];
      for (const { unit, baseline } of units) {
        current = unit;
        const files = await changesSince(unit.workdir, baseline!);
        const own = files.filter((f) => f.origin === 'task').map((f) => f.path);
        const mixed = files.filter((f) => f.origin === 'both').map((f) => f.path);
        const commit = await commitPaths(unit.workdir, own, `${task.id}: ${task.title}\n\nCreated by AI Development Control Center (${def.name}).`);
        if (!commit) continue;
        const git = unit.folder ? taskRepositories(store, store.getTask(task.id)!).find((r) => r.repo.id === unit.repo.id)!.git : store.getTask(task.id)!.git;
        if (unit.folder) publisher.updateRepositoryGit(task.id, unit.repo.id, { commits: [...git.commits, commit] });
        else store.updateTask(task.id, { git: { ...git, commits: [...git.commits, commit] } });
        made.push({ commit, files: own.length, folder: unit.folder });
        publisher.event(
          task.id,
          'GIT_COMMIT',
          `${unit.folder ? `${unit.repo.name}: c` : 'C'}ommitted ${own.length} file${own.length === 1 ? '' : 's'} on ${unit.git.taskBranch ?? 'the current branch'} (${commit.slice(0, 10)})`,
          { commit, files: own, ...(unit.folder ? { repositoryId: unit.repo.id } : {}) },
          stage.id,
        );
        if (mixed.length) {
          publisher.event(task.id, 'FILE_CHANGED', `${mixed.length} file(s) containing your pre-existing work were left uncommitted: ${mixed.map((f) => inFolder(unit.folder, f)).join(', ')}`, { files: mixed }, stage.id);
        }
      }
      current = null;
      if (!made.length) {
        publisher.updateStage(stage.id, { status: 'SKIPPED', summary: 'Nothing to commit', finishedAt: now() });
        publisher.event(task.id, 'STAGE_SKIPPED', `${def.name}: nothing to commit`, {}, stage.id);
        return { kind: 'skipped', stageId: stage.id };
      }
      const summary = made.map((m) => `${m.folder ? `${m.folder}: ` : ''}${m.files} file(s) as ${m.commit.slice(0, 10)}`).join('; ');
      publisher.updateStage(stage.id, { status: 'SUCCESS', summary: `Committed ${summary}`, finishedAt: now() });
      return { kind: 'success', stageId: stage.id };
    } catch (error) {
      const failedIn = current?.folder ? ` in ${current.repo.name}` : '';
      const message = `Git commit failed${failedIn}: ${(error as Error).message}`;
      // A rejecting pre-commit hook (a docs guard, a linter) names something an
      // agent can fix, so a stage with a failure route treats it like a failed
      // test: the fix stage sees the message in its test results and the
      // checkpoint runs again after it.
      if (def.onFail) {
        const clean = redact(message);
        publisher.updateStage(stage.id, { status: 'FAILED', errorClass: 'COMMAND_FAILURE', errorMessage: clean, summary: clean, finishedAt: now() });
        publisher.event(task.id, 'STAGE_FAILED', `${def.name} was rejected by the repository: ${clean}`, { errorClass: 'COMMAND_FAILURE' }, stage.id);
        return { kind: 'tests_failed', stageId: stage.id, message: clean };
      }
      return this.failStage(stage, 'COMMAND_FAILURE', message);
    }
  }

  /** Every repository the task works in, primary first; for a single-repository task just `repo`. */
  private units(task: TaskRecord, repo: RepositoryRecord): RepoUnit[] {
    const all = taskRepositories(this.d.store, task);
    if (all.length <= 1) return [{ repo, workdir: taskWorkdir(task, repo), folder: null, git: task.git }];
    return all.map((r) => ({ repo: r.repo, workdir: r.workdir, folder: r.folder, git: r.git }));
  }

  failStage(stage: StageInstance, errorClass: ErrorClass, message: string): StageOutcome {
    const clean = redact(message);
    this.d.publisher.updateStage(stage.id, {
      status: errorClass === 'USAGE_LIMIT' ? 'PAUSED' : 'FAILED',
      errorClass,
      errorMessage: clean,
      finishedAt: now(),
    });
    this.d.publisher.event(stage.taskId, 'STAGE_FAILED', `${stage.name} failed: ${ERROR_CLASS_LABEL[errorClass]} — ${clean}`, { errorClass }, stage.id);
    return { kind: 'error', stageId: stage.id, errorClass, message: clean };
  }

  private publishTestRun(testRun: TestRun): void {
    this.d.bus.publish({ type: 'testRun', testRun });
  }
}
