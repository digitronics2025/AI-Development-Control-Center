import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { addWorktree, changesSince, commitPaths, createCheckpoint, isGitRepository, removeWorktree, repositoryStatus, taskBranchName } from '@acc/git';
import { redact } from '@acc/security';
import { DEFAULT_AUTO_APPROVE_LEVEL, requestedSkills, type CommandKind, type EventType, type PermissionLevel, type PolicyMode, type StageDefinition, type StageInstance, type TestRun } from '@acc/shared';
import {
  assessVerification,
  classifyFailure,
  closeBrowserPages,
  collectEnvironment,
  declaredDependencies,
  environmentMarkdown,
  FAILURE_LABEL,
  packageManager,
  planRepair,
  policyCeiling,
  profileForRepository,
  projectType,
  type FailureClassification,
  type RepairPlan,
  type RepairStrategy,
} from '@acc/tools';
import type { Bus } from '../bus.js';
import type { AgentRegistry } from '../services/agents.js';
import type { ArtifactService } from '../services/artifacts.js';
import type { SettingsService } from '../services/settings.js';
import type { SkillCatalog } from '../services/skills.js';
import { newId, now, type RepositoryRecord, type Store, type TaskRecord } from '../store/store.js';
import type { McpService } from '../tools/mcp.js';
import type { ProcessManager } from '../tools/processes.js';
import type { ToolScope, ToolService } from '../tools/service.js';
import type { ToolStore } from '../tools/store.js';
import type { TerminalService } from '../tools/terminals.js';
import type { Publisher } from './publisher.js';
import { taskWorkdir } from './workdir.js';

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

/** How the operator's own skills and outside tools behave inside a Control Center run (docs/systems/agents.md). */
export const SKILLS_PROMPT_SECTION = [
  '## Skills',
  '',
  "The operator's installed skills are available in this run; use one when it fits the work.",
  "This stage's limits still apply to everything a skill does. A skill or tool that is refused is an operator decision: report it, do not work around it.",
  "The operator's personal MCP servers are not connected here. Where a skill expects one (a browser, Cloudflare, Android), use the matching Control Center tool when this run has them; otherwise report that step as not verified.",
].join('\n');

export interface AgentToolBridge {
  command: string;
  args: string[];
  env: Record<string, string>;
  close(): void;
}

export interface EngineToolingDeps {
  store: Store;
  bus: Bus;
  tools: ToolService;
  toolStore: ToolStore;
  processes: ProcessManager;
  terminals: TerminalService;
  settings: SettingsService;
  artifacts: ArtifactService;
  agents: AgentRegistry;
  mcp: McpService | null;
  /** Skills the agents would load; null in tests that build tooling by hand. */
  skills?: SkillCatalog | null;
  dataDir: string;
  /** Built stdio MCP bridge agents launch; null in development without a build. */
  bridgePath: string | null;
}

/**
 * The engine's side of the tool layer (docs/plans/tool-layer-v2): builds
 * tool scopes from tasks, discovers the environment, gives agent stages a
 * tool session, repairs infrastructure failures, runs the `verify` stage,
 * isolates tasks in worktrees and cleans up everything a task started.
 */
export class EngineTooling {
  private publisher: Publisher | null = null;
  private listenUrl: string | null = null;

  constructor(private readonly d: EngineToolingDeps) {}

  attachPublisher(publisher: Publisher): void {
    this.publisher = publisher;
  }

  /** Known once the HTTP server listens; agent tool sessions need it. */
  setListenUrl(url: string): void {
    this.listenUrl = url;
  }

  get tools(): ToolService {
    return this.d.tools;
  }

  private event(taskId: string, type: EventType, message: string, data: Record<string, unknown> = {}, stageId?: string | null): void {
    this.publisher?.event(taskId, type, message, data, stageId ?? null);
  }

  policyMode(task: TaskRecord, repo: RepositoryRecord): PolicyMode {
    return task.policyMode ?? repo.policyMode ?? this.d.settings.get().execution.policyMode;
  }

  /** Highest level that runs without asking for this task: its auto-approve level under its policy mode. */
  autoApproveLevel(task: TaskRecord, repo: RepositoryRecord): PermissionLevel {
    return policyCeiling(this.policyMode(task, repo), task.autoApproveUpToLevel ?? DEFAULT_AUTO_APPROVE_LEVEL);
  }

  scope(task: TaskRecord, repo: RepositoryRecord, stage: { level: PermissionLevel; stageId: string | null }, sessionId: string | null = null): ToolScope {
    const cwd = taskWorkdir(task, repo);
    return {
      taskId: task.id,
      stageId: stage.stageId,
      sessionId,
      repositoryId: repo.id,
      cwd,
      roots: [cwd],
      stageLevel: stage.level,
      autoApproveUpToLevel: task.autoApproveUpToLevel ?? DEFAULT_AUTO_APPROVE_LEVEL,
      mode: this.policyMode(task, repo),
      profile: profileForRepository(repo.tooling, stage.level),
      escalated: new Set(),
      protectedPaths: task.git.isolated ? [] : task.git.preexistingChanges,
    };
  }

  // ===========================================================================
  // Environment discovery (V2 plan §36)
  // ===========================================================================

  async discoverEnvironment(task: TaskRecord, repo: RepositoryRecord): Promise<string | null> {
    if (!this.d.settings.get().execution.environmentDiscovery) return null;
    const existing = this.d.store.latestArtifactOfType(task.id, 'environment');
    if (existing) return (await this.d.artifacts.latestText(task.id, 'environment')) ?? null;
    const cwd = taskWorkdir(task, repo);
    let branch: string | null = null;
    let dirty: number | null = null;
    try {
      const st = await repositoryStatus(cwd);
      branch = st.branch.head;
      dirty = st.entries.length;
    } catch {
      /* not a Git repository */
    }
    const tools = this.d.tools.registry
      .listProviders({ platform: process.platform })
      .filter((p) => !p.builtin && !p.id.startsWith('mcp:'))
      .map((p) => ({ id: p.id, name: p.name, detection: this.d.tools.health.get(p.id) }));
    let ports: Array<{ port: number; process: string | null; pid: number | null }> = [];
    try {
      const outcome = await this.d.tools.invoke({ capability: 'network.port_owner', input: {}, origin: 'engine', scope: this.scope(task, repo, { level: 1, stageId: null }), timeoutMs: 30_000 });
      ports = ((outcome.result.output as { owners?: Array<{ port: number; process?: string | null; pid?: number | null }> })?.owners ?? []).slice(0, 40).map((o) => ({ port: o.port, process: o.process ?? null, pid: o.pid ?? null }));
    } catch {
      /* optional */
    }
    const report = await collectEnvironment({
      cwd,
      branch,
      dirtyFiles: dirty,
      tooling: repo.tooling,
      projectType: projectType(repo.tooling),
      tools,
      listeningPorts: ports,
      taskProcesses: this.d.processes.list(task.id).filter((p) => ['running', 'healthy', 'starting'].includes(p.status)).map((p) => ({ name: p.name, port: p.port, status: p.status })),
      agents: this.d.agents.list().map((a) => ({ id: a.id, state: a.health.state })),
      mcpServers: (this.d.mcp?.list() ?? []).filter((s) => s.enabled).map((s) => ({ name: s.name, state: s.health?.ok ? 'ready' : 'unavailable', tools: s.health?.tools.length ?? 0 })),
    });
    const markdown = environmentMarkdown(report);
    await this.d.artifacts.write(task.id, { name: 'environment.md', type: 'environment', content: `# Environment\n\nCollected ${report.collectedAt}\n\n${markdown}\n` });
    this.event(task.id, 'ENVIRONMENT_DISCOVERED', `Environment: ${report.machine.os} ${report.machine.arch} · ${report.tools.filter((t) => t.installed).length} tools available · ${report.listeningPorts.length} listening ports`, {});
    return markdown;
  }

  // ===========================================================================
  // Agent tool sessions (V2 plan §30, §44)
  // ===========================================================================

  openAgentSession(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord): AgentToolBridge | null {
    if (!this.d.settings.get().execution.exposeToolsToAgents || !this.listenUrl || !this.d.bridgePath) return null;
    const scope = this.scope(task, repo, { level: def.permissionLevel, stageId: stage.id });
    const { sessionId: _s, escalated: _e, ...base } = scope;
    const session = this.d.tools.openSession(base, 'agent', def.timeoutSec * 1000 + 10 * 60_000);
    return {
      command: process.execPath,
      args: [this.d.bridgePath],
      env: { ACC_TOOL_URL: this.listenUrl, ACC_TOOL_SESSION: session.token },
      close: () => this.d.tools.closeSession(session.id),
    };
  }

  /** "## Control Center tools" section appended to agent prompts. */
  toolsPromptSection(task: TaskRecord, def: StageDefinition, repo: RepositoryRecord): string {
    if (!this.d.settings.get().execution.exposeToolsToAgents || !this.listenUrl || !this.d.bridgePath) return '';
    const profile = profileForRepository(repo.tooling, def.permissionLevel);
    return [
      '## Control Center tools',
      '',
      `This run has the Control Center's tools as an MCP server named "acc" (profile: ${profile}, stage Level ${def.permissionLevel}, policy ${this.policyMode(task, repo)}).`,
      'Prefer them to raw commands for: checking the app in a real browser (browser.check_page, verify.web), HTTP checks (http.request), who holds a port (network.port_owner), background dev servers (process.start — stopped for you at the end), databases, Cloudflare, Android and GitHub.',
      'Use acc_find_capability to discover more and acc_call_capability to call one that is not listed. A refusal explains why; do not work around it — report it as an operator decision.',
    ].join('\n');
  }

  // ===========================================================================
  // Repairs in test stages (V2 plan §17)
  // ===========================================================================

  classify(tail: string[], timedOut: boolean): FailureClassification {
    return classifyFailure(tail, { timedOut });
  }

  plan(failure: FailureClassification, workdir: string, attempted: RepairStrategy[]): RepairPlan | null {
    if (!this.d.settings.get().execution.autoRepair) return null;
    if (attempted.length >= this.d.settings.get().execution.maxRepairAttempts) return null;
    return planRepair(failure, {
      packageManager: packageManager(workdir),
      hasRequirementsTxt: existsSync(path.join(workdir, 'requirements.txt')),
      declaredDependencies: declaredDependencies(workdir),
      nodeModulesPresent: existsSync(path.join(workdir, 'node_modules')),
      attempted,
    });
  }

  recordRepair(task: TaskRecord, stageId: string, command: string, failure: FailureClassification, plan: RepairPlan, attempt: number) {
    const row = {
      id: newId(),
      taskId: task.id,
      stageId,
      command: redact(command).slice(0, 500),
      category: failure.category,
      strategy: plan.strategy,
      status: 'running' as const,
      detail: plan.description,
      evidence: failure.evidence ? redact(failure.evidence) : null,
      attempt,
      createdAt: now(),
      finishedAt: null,
    };
    this.d.toolStore.insertRecovery(row);
    this.d.bus.publish({ type: 'recovery', attempt: row });
    this.event(task.id, 'RECOVERY_ATTEMPT', `${FAILURE_LABEL[failure.category]} — ${plan.description}`, { recoveryId: row.id, category: failure.category, strategy: plan.strategy }, stageId);
    return row;
  }

  finishRepair(id: string, ok: boolean, detail: string) {
    const attempt = this.d.toolStore.finishRecovery(id, ok ? 'succeeded' : 'failed', redact(detail).slice(0, 500));
    this.d.bus.publish({ type: 'recovery', attempt });
    return attempt;
  }

  /** Extra prompt sections: the environment report (first stages), skills, and the tools this run has. */
  async promptSections(task: TaskRecord, def: StageDefinition, repo: RepositoryRecord): Promise<string> {
    const parts: string[] = [];
    parts.push(SKILLS_PROMPT_SECTION);
    const requested = await this.requestedSkillsSection(task, def, repo);
    if (requested) parts.push(requested);
    if (['investigator', 'planner', 'implementer'].includes(def.role)) {
      const env = await this.d.artifacts.latestText(task.id, 'environment', 20_000);
      if (env) parts.push(`## Environment (collected by the Control Center)\n\n${env.replace(/^# Environment\s*/, '').trim()}`);
    }
    const tools = this.toolsPromptSection(task, def, repo);
    if (tools) parts.push(tools);
    return parts.length ? `\n\n${parts.join('\n\n')}\n` : '';
  }

  /**
   * "## Requested skills": the skills the operator named as `/name` in the task
   * description (the New Task slash picker), with where each belongs. Only real
   * skill names count, so a path such as `/api/tasks` is never read as one.
   */
  async requestedSkillsSection(task: TaskRecord, def: StageDefinition, repo: RepositoryRecord): Promise<string> {
    // The description and the directives this stage receives (the Directive box has the same picker).
    const directives = this.d.store
      .listDirectives(task.id)
      .filter((d) => d.state === 'active' && d.kind !== 'routing' && (d.scope === 'CURRENT_TASK' || d.appliedStageKey === def.key))
      .map((d) => d.text);
    const text = [task.description, ...directives].join('\n');
    if (!this.d.skills || !text.includes('/')) return '';
    const catalog = await this.d.skills.list(repo.path).catch(() => null);
    if (!catalog) return '';
    const byName = new Map(catalog.skills.map((s) => [s.name, s]));
    const names = requestedSkills(text, new Set(byName.keys()));
    if (!names.length) return '';
    return [
      '## Requested skills',
      '',
      'The operator asked for these skills by name (`/name` in the task or a directive):',
      ...names.map((name) => {
        const description = byName.get(name)?.description;
        return `- \`${name}\`${description ? ` — ${description}` : ''}`;
      }),
      '',
      `You are the ${def.role} in stage "${def.name}". Run a requested skill with your skill mechanism (the Skill tool in Claude Code) in the stage whose job it matches: skills that change code in implementation or fix stages; review, audit and check skills in review or verification stages; investigation and planning skills in those stages. When no stage clearly fits, the implementation stage runs it.`,
      "Run each at most once in this stage and name in your report the skills you ran. A skill this stage's limits refuse is an operator decision: report it, do not work around it.",
    ].join('\n');
  }

  /** Free a port only when this task's own process holds it; say who holds it otherwise. */
  async freePort(task: TaskRecord, repo: RepositoryRecord, port: number): Promise<{ ok: boolean; detail: string }> {
    const outcome = await this.d.tools.invoke({ capability: 'network.port_owner', input: { port }, origin: 'engine', scope: this.scope(task, repo, { level: 1, stageId: null }) });
    const owners = (outcome.result.output as { owners?: Array<{ pid: number | null; process?: string | null }> })?.owners ?? [];
    if (!owners.length) return { ok: true, detail: `Port ${port} is free now` };
    const ours = this.d.processes.list(task.id).filter((p) => ['running', 'healthy', 'starting', 'unhealthy'].includes(p.status));
    const owned = owners.filter((o) => o.pid !== null && this.d.processes.owns(task.id, o.pid));
    if (owned.length && owned.length === owners.length) {
      for (const p of ours) if (p.port === port || owned.some((o) => o.pid === p.pid)) await this.d.processes.stop(p.id, `freeing port ${port}`);
      return { ok: true, detail: `Stopped this task's own process on port ${port}` };
    }
    const holder = owners.map((o) => `${o.process ?? 'a process'} (pid ${o.pid})`).join(', ');
    return { ok: false, detail: `Port ${port} is held by ${holder}, which this task did not start — left alone` };
  }

  // ===========================================================================
  // Worktrees (V2 plan §15)
  // ===========================================================================

  worktreeRoot(repo: RepositoryRecord): string {
    const slug = `${repo.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}-${repo.id.slice(0, 6)}`;
    return path.join(this.d.dataDir, 'worktrees', slug);
  }

  /** Create the task's worktree and branch; returns the new git record fields, or null to fall back to a task branch. */
  async createWorktree(task: TaskRecord, repo: RepositoryRecord): Promise<{ worktreePath: string; taskBranch: string; head: string } | null> {
    if (!(await isGitRepository(repo.path))) return null;
    const dir = path.join(this.worktreeRoot(repo), task.id);
    mkdirSync(path.dirname(dir), { recursive: true });
    try {
      const { branch, head } = await addWorktree(repo.path, dir, taskBranchName(task.id, task.title));
      this.event(task.id, 'WORKTREE_CREATED', `Working in an isolated worktree on ${branch}; your working tree is not touched`, { path: dir, branch });
      return { worktreePath: dir, taskBranch: branch, head };
    } catch (error) {
      this.event(task.id, 'WORKTREE_CREATED', `Could not create a worktree (${redact((error as Error).message).slice(0, 200)}); using a task branch instead`, {});
      return null;
    }
  }

  /**
   * A fresh worktree has no dependencies installed; install them once from the
   * lockfile. Without a lockfile an install would write one into the task's
   * changes, so it is left to the test stage's repair instead.
   */
  async prepareWorktree(task: TaskRecord, repo: RepositoryRecord): Promise<void> {
    const cwd = taskWorkdir(task, repo);
    if (!packageManager(cwd) || existsSync(path.join(cwd, 'node_modules'))) return;
    if (!LOCKFILES.some((f) => existsSync(path.join(cwd, f)))) {
      this.event(task.id, 'TOOL_CALL', 'No lockfile in the worktree: dependencies are installed when a check needs them', {});
      return;
    }
    const outcome = await this.d.tools.invoke({ capability: 'node.install', input: { frozen: true }, origin: 'engine', scope: this.scope(task, repo, { level: 2, stageId: null }), preApproved: true, timeoutMs: 20 * 60_000 });
    this.event(task.id, 'TOOL_CALL', `Installed dependencies in the worktree: ${outcome.result.summary}`, { executionId: outcome.execution.id, ok: outcome.result.ok });
  }

  /**
   * Finish an isolated task: commit what it left uncommitted to its branch
   * (completed), or keep it in a checkpoint ref (cancelled), then remove the
   * worktree. The branch stays for you to merge.
   */
  async finalizeWorktree(task: TaskRecord, repo: RepositoryRecord, outcome: 'completed' | 'cancelled'): Promise<Partial<TaskRecord['git']>> {
    const dir = task.git.worktreePath;
    if (!dir) return {};
    const patch: Partial<TaskRecord['git']> = {};
    try {
      const baseline = task.git.baselineSnapshotId ? this.d.store.getSnapshot(task.git.baselineSnapshotId) : null;
      const files = baseline && existsSync(dir) ? await changesSince(dir, baseline) : [];
      const pending = files.filter((f) => f.origin === 'task').map((f) => f.path);
      if (pending.length && outcome === 'completed') {
        const commit = await commitPaths(dir, pending, `${task.id}: ${task.title}\n\nRemaining changes, committed when the task completed (AI Development Control Center).`);
        if (commit) {
          patch.commits = [...task.git.commits, commit];
          this.event(task.id, 'GIT_COMMIT', `Committed ${pending.length} remaining file(s) on ${task.git.taskBranch} (${commit.slice(0, 10)})`, { commit, files: pending });
        }
      } else if (pending.length) {
        const ref = `refs/acc/worktree-backup/${task.id}`;
        const cp = await createCheckpoint(dir, ref, `${task.id}: uncommitted work when the task was cancelled`);
        this.event(task.id, 'CHECKPOINT_CREATED', `Kept ${pending.length} uncommitted file(s) in ${ref} (${cp.commit.slice(0, 10)}) before removing the worktree`, { ref, commit: cp.commit });
      }
      const removed = await removeWorktree(repo.path, dir, { force: outcome === 'cancelled' || pending.length > 0 });
      if (removed) {
        patch.worktreePath = null;
        this.event(task.id, 'WORKTREE_REMOVED', `Worktree removed; the work is on branch ${task.git.taskBranch}${outcome === 'completed' ? ' — merge it from Source Control' : ''}`, { branch: task.git.taskBranch });
      }
    } catch (error) {
      this.event(task.id, 'WORKTREE_REMOVED', `The worktree could not be cleaned up: ${redact((error as Error).message).slice(0, 200)}. It is kept at ${dir}.`, {});
    }
    return patch;
  }

  // ===========================================================================
  // Cleanup (V2 plan §39, §43)
  // ===========================================================================

  /** Stop everything the task started. Returns a line for the report. */
  async cleanup(task: TaskRecord, repo: RepositoryRecord | null, reason: string): Promise<string[]> {
    const lines: string[] = [];
    this.d.tools.closeSessionsForTask(task.id);
    const pagesClosed = await closeBrowserPages(task.id).catch(() => 0);
    if (pagesClosed) lines.push(`Closed ${pagesClosed} browser page(s) the task left open`);
    const stopped = await this.d.processes.stopForTask(task.id, reason);
    if (stopped) {
      lines.push(`Stopped ${stopped} background process(es) the task started`);
      this.event(task.id, 'PROCESS_STOPPED', `Stopped ${stopped} background process(es): ${reason}`, {});
    }
    await this.d.terminals.closeForTask(task.id);
    const usedDocker = this.d.toolStore.listExecutions({ taskId: task.id, limit: 500 }).some((e) => e.capability.startsWith('docker.') && e.status === 'succeeded');
    if (usedDocker && repo) {
      const outcome = await this.d.tools.invoke({ capability: 'docker.cleanup', input: {}, origin: 'engine', scope: this.scope(task, repo, { level: 2, stageId: null }), preApproved: true });
      lines.push(outcome.result.summary);
    }
    return lines;
  }

  async stopProcesses(taskId: string, reason: string): Promise<void> {
    await closeBrowserPages(taskId).catch(() => 0);
    const stopped = await this.d.processes.stopForTask(taskId, reason).catch(() => 0);
    await this.d.terminals.closeForTask(taskId).catch(() => undefined);
    if (stopped) this.event(taskId, 'PROCESS_STOPPED', `Stopped ${stopped} background process(es): ${reason}`, {});
  }

  /** Which checks the project type needs and which were observed (V2 plan §42). */
  verificationCoverage(task: TaskRecord, repo: RepositoryRecord, stages: StageInstance[], testRuns: TestRun[]): { type: string; satisfied: string[]; missing: string[] } {
    const lastTests = [...stages].reverse().find((s) => s.kind === 'tests');
    const passedKinds = new Set<CommandKind>(testRuns.filter((r) => r.status === 'passed' && (r.stageId === lastTests?.id || r.kind === 'e2e')).map((r) => r.kind));
    const observed = new Set<'browser' | 'http' | 'device'>();
    const ok = (prefix: string) => this.d.toolStore.listExecutions({ taskId: task.id, limit: 1000 }).some((e) => e.capability.startsWith(prefix) && e.status === 'succeeded');
    if (ok('verify.web') || ok('browser.check_page') || ok('browser.run_flow')) observed.add('browser');
    if (ok('http.') || ok('verify.web')) observed.add('http');
    if (ok('android.launch')) observed.add('device');
    const type = projectType(repo.tooling);
    const assessment = assessVerification(type, { passedKinds, observed });
    return { type, satisfied: assessment.satisfied.map((c) => c.label), missing: assessment.missing.map((c) => `${c.label}${c.advisory ? ' (optional)' : ''}`) };
  }

  /** Short account of tool activity for the final report. */
  reportSection(task: TaskRecord): string[] {
    const executions = this.d.toolStore.listExecutions({ taskId: task.id, limit: 1000 });
    const recovery = this.d.toolStore.listRecovery(task.id);
    const escalations = this.d.toolStore.listEscalations(task.id);
    const processes = this.d.processes.list(task.id);
    if (!executions.length && !recovery.length && !processes.length) return [];
    const byStatus = (s: string) => executions.filter((e) => e.status === s).length;
    const lines = [`- Tool calls: ${executions.length} (${byStatus('succeeded')} succeeded, ${byStatus('failed')} failed, ${byStatus('denied') + byStatus('needs_approval')} refused)`];
    if (recovery.length) lines.push(`- Automatic repairs: ${recovery.map((r) => `${r.strategy} (${r.status})`).join(', ')}`);
    const enabled = escalations.filter((e) => e.decision === 'enabled');
    if (enabled.length) lines.push(`- Capabilities enabled on the fly: ${[...new Set(enabled.map((e) => e.capability))].join(', ')}`);
    const refused = escalations.filter((e) => e.decision !== 'enabled');
    if (refused.length) lines.push(`- Refused by policy: ${[...new Set(refused.map((e) => e.capability))].join(', ')}`);
    if (processes.length) lines.push(`- Background processes: ${processes.map((p) => `${p.name} (${p.status})`).join(', ')}`);
    return lines;
  }

  async writeReportArtifact(taskId: string, name: string, content: string): Promise<void> {
    await this.d.artifacts.write(taskId, { name, type: 'browser-report', content });
  }
}

export async function writeTempFile(dir: string, name: string, content: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, content, { mode: 0o600 });
  return file;
}
