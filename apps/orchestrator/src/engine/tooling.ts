import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { lstat, mkdir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { addWorktree, changesSince, commitPaths, createCheckpoint, deleteBranchIfAt, git, headCommit, isGitRepository, removeWorktree, repositoryStatus, status, taskBranchName } from '@acc/git';
import { redact } from '@acc/security';
import { DEFAULT_AUTO_APPROVE_LEVEL, requestedSkills, SKILL_TOKEN, type CommandKind, type EventType, type PermissionLevel, type PolicyMode, type StageDefinition, type StageInstance, type TestRun, roleClass } from '@acc/shared';
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
  type ProfileId,
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
import { agentWorkdir, taskRepositories } from './task-repositories.js';
import { taskWorkdir } from './workdir.js';

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

/**
 * Written into node_modules only after a lockfile install succeeded. A folder
 * without it — an install a restart or a shutdown cut short — is installed again.
 */
export const INSTALL_MARKER = '.acc-install-complete';

/**
 * npm's hidden lockfile: `npm ci` empties node_modules first (the marker with
 * it) and writes this last, only when the install finished. So it proves a
 * repair's `npm ci`, or an agent's, completed where the marker cannot.
 */
const NPM_INSTALL_COMPLETE = '.package-lock.json';

/** `child` is `parent` or inside it (case-insensitive on Windows). */
function isInsidePath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** One folder, however Git or Node spells it (`C:/x` and `C:\x`; case-insensitive on Windows). */
function samePath(a: string, b: string): boolean {
  return path.relative(path.resolve(a), path.resolve(b)) === '';
}

/** Whether a worktree's dependencies were installed to the end (`prepareWorktree`). */
function installComplete(cwd: string, pm: ReturnType<typeof packageManager>): boolean {
  const modules = path.join(cwd, 'node_modules');
  return existsSync(path.join(modules, INSTALL_MARKER)) || (pm === 'npm' && existsSync(path.join(modules, NPM_INSTALL_COMPLETE)));
}

/** Told to a read-only stage that starts while the worktree's dependencies are still installing. */
export const INSTALLING_PROMPT_SECTION = [
  '## Dependencies',
  '',
  "The worktree's dependencies are still being installed while this read-only stage runs, so node_modules may be incomplete.",
  'Do not run or draw conclusions from project scripts, builds or tests here: the Control Center finishes the install before any stage that runs code.',
].join('\n');

/**
 * Whether a text holds a `/name` token that is not a path segment — the rule
 * `requestedSkills` applies before it looks a name up — so only such a text is
 * worth listing the skills catalog for.
 */
function mentionsSkillToken(text: string): boolean {
  for (const match of text.matchAll(SKILL_TOKEN)) if (text[(match.index ?? 0) + match[0].length] !== '/') return true;
  return false;
}

/** How to look at UI work with the Control Center's tools (docs/systems/design-agent.md). */
export const VISUAL_LOOP_LINE =
  'For UI work, look at the result, not the code alone: browser.open with viewport and colorScheme (then browser.snapshot and browser.act for states), browser.visual_matrix for every width in light and dark as contact sheets, browser.accessibility for WCAG failures with the failing elements, browser.render_html to draw a style tile you wrote (scripts off, nothing fetched), design.contrast_matrix for the WCAG contrast of the colour roles in both themes, design.lint_tokens for colours and palette classes written as literals instead of the design standard values, browser.audit for load time, layout shift and image weight, browser.visual_diff against a saved picture when the plan keeps baselines, and media.image.view / media.video.frames for image and video files; media.asset.optimize, media.svg.optimize and media.video.encode prepare files for the web.';

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

/**
 * One stage run's tool session (V2 plan §30, SEC-3). `bridge` is the MCP
 * server when the Control Center's tools are offered to agents; `shellGuard`
 * is the command hook that prechecks the agent's native shell commands and file reads, when
 * its script is built here. Both carry the same session in `env`; a session
 * opened for the guard alone opens no tool route.
 */
export interface AgentRunSession {
  bridge: { command: string; args: string[]; env: Record<string, string> } | null;
  shellGuard: { command: string; args: string[]; env: Record<string, string> } | null;
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
  /** Where task worktrees and workspaces live, outside the data folder (`defaultWorkDir`). */
  workDir: string;
  /** Built stdio MCP bridge agents launch; null in development without a build. */
  bridgePath: string | null;
  /** Built native shell precheck hook (SEC-3); null without a build, and then no native shell from Level 2. */
  shellGuardPath?: string | null;
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
  /** Worktree dependency installs running beside read-only stages, per task (`startInstall`). */
  private readonly installs = new Map<string, { done: Promise<void>; controller: AbortController }>();
  /** Worktrees already told they have no lockfile: every loop of a task checks its install again. */
  private readonly noLockfileAnnounced = new Set<string>();
  /** The trash sweep in flight, and whether another was asked for meanwhile (`emptyTrash`). */
  private trashSweep: Promise<number> | null = null;
  private trashAgain = false;

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

  /**
   * The tool scope of a task. Its root is where the task's agents work (the
   * workspace of a multi-repository task); `stage.cwd` starts a call in a
   * folder inside that root, e.g. one repository of the workspace.
   */
  scope(task: TaskRecord, repo: RepositoryRecord, stage: { level: PermissionLevel; stageId: string | null; cwd?: string; profile?: ProfileId }, sessionId: string | null = null): ToolScope {
    const root = agentWorkdir(task, repo);
    const units = taskRepositories(this.d.store, task);
    const multi = units.length > 1;
    return {
      taskId: task.id,
      stageId: stage.stageId,
      sessionId,
      repositoryId: repo.id,
      cwd: stage.cwd ?? root,
      roots: [root],
      stageLevel: stage.level,
      autoApproveUpToLevel: task.autoApproveUpToLevel ?? DEFAULT_AUTO_APPROVE_LEVEL,
      mode: this.policyMode(task, repo),
      // Across repositories the task may need any of their tools; permission still comes from level and policy.
      // A stage's own toolProfile wins; otherwise the profile the repository's tooling suggests.
      profile: stage.profile ?? profileForRepository(multi ? [...new Set(units.flatMap((u) => u.repo.tooling))] : repo.tooling, stage.level),
      escalated: new Set(),
      protectedPaths: task.git.isolated ? [] : task.git.preexistingChanges,
      ...(multi ? { repositories: units.map((u) => ({ id: u.repo.id, root: u.workdir })) } : {}),
    };
  }

  /**
   * A scope for a read the operator asked for outside any task (a release's
   * Check setup): one repository, the operator profile, `level` as the ceiling.
   */
  repositoryScope(repo: RepositoryRecord, level: PermissionLevel): ToolScope {
    return {
      taskId: null,
      stageId: null,
      sessionId: null,
      repositoryId: repo.id,
      cwd: repo.path,
      roots: [repo.path],
      stageLevel: level,
      autoApproveUpToLevel: level,
      mode: repo.policyMode ?? this.d.settings.get().execution.policyMode,
      profile: 'operator',
      escalated: new Set(),
      protectedPaths: [],
    };
  }

  // ===========================================================================
  // Environment discovery (V2 plan §36)
  // ===========================================================================

  async discoverEnvironment(task: TaskRecord, repo: RepositoryRecord): Promise<string | null> {
    if (!this.d.settings.get().execution.environmentDiscovery) return null;
    const existing = this.d.store.latestArtifactOfType(task.id, 'environment');
    if (existing) return (await this.d.artifacts.latestText(task.id, 'environment')) ?? null;
    const cwd = agentWorkdir(task, repo);
    // The workspace root is not a repository: Git status comes from the primary repository's worktree.
    const statusDir = task.git.workspacePath ? taskWorkdir(task, repo) : cwd;
    let branch: string | null = null;
    let dirty: number | null = null;
    try {
      const st = await repositoryStatus(statusDir);
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

  /**
   * `opts.root` confines the session to one folder (a Stage Team worker's
   * disposable checkout: its only working directory and only root);
   * `opts.level` lowers the level (a read-only decomposition run). With tools
   * off for agents the session still exists for the shell guard alone
   * (`guardOnly`: it opens no tool route), so turning tools off does not take
   * the native shell away; null only when neither can run here. With agent
   * isolation on, stage runs get the guard alone (`stageToolsOffered`).
   */
  openAgentSession(task: TaskRecord, def: StageDefinition, stage: StageInstance, repo: RepositoryRecord, opts: { root?: string; level?: PermissionLevel } = {}): AgentRunSession | null {
    const offered = this.stageToolsOffered();
    const guard = this.d.shellGuardPath ?? null;
    if (!this.listenUrl || (!offered && !guard)) return null;
    const level = opts.level !== undefined ? (Math.min(opts.level, def.permissionLevel) as PermissionLevel) : def.permissionLevel;
    const scope = this.scope(task, repo, { level, stageId: stage.id, ...(opts.root ? { cwd: opts.root } : {}), ...(def.toolProfile ? { profile: def.toolProfile } : {}) });
    // A design stage never reaches an outside MCP tool (ToolScope.designSession): it could bill past the spend gate.
    // Judged on the stage as it runs and as the workflow declares it, so a specialist on a design stage keeps it.
    const declared = task.workflow.stages.find((s) => s.key === def.key);
    if ([def, declared].some((d) => d && (d.role === 'designer' || d.toolProfile === 'frontend-design'))) scope.designSession = true;
    const { sessionId: _s, escalated: _e, repositories: _r, ...rest } = scope;
    const base = opts.root ? { ...rest, roots: [opts.root], protectedPaths: [] } : { ...rest, ...(scope.repositories ? { repositories: scope.repositories } : {}) };
    const session = this.d.tools.openSession(base, 'agent', def.timeoutSec * 1000 + 10 * 60_000, { guardOnly: !offered });
    const env = { ACC_TOOL_URL: this.listenUrl, ACC_TOOL_SESSION: session.token };
    return {
      bridge: offered ? { command: process.execPath, args: [this.d.bridgePath!], env } : null,
      shellGuard: guard ? { command: process.execPath, args: [guard], env } : null,
      close: () => this.d.tools.closeSession(session.id),
    };
  }

  /**
   * Whether a stage run gets the Control Center's tools: not when they are
   * off or not built, and not when stage runs start as the agent account
   * (docs/systems/security.md#agent-os-boundary) — the tools run as the
   * operator, so a run could have them read what its account may not.
   */
  private stageToolsOffered(): boolean {
    const settings = this.d.settings.get();
    return settings.execution.exposeToolsToAgents && Boolean(this.d.bridgePath) && settings.agentIsolation.mode !== 'account';
  }

  /** Why an agent run cannot get the Control Center's tools right now, or null when it can. */
  bridgeUnavailableReason(): string | null {
    if (!this.d.settings.get().execution.exposeToolsToAgents) return 'Giving agents the Control Center tools is turned off in Settings → Tools policy.';
    if (!this.listenUrl || !this.d.bridgePath) return 'The tool bridge is not built on this machine.';
    return null;
  }

  /**
   * A tool session and its MCP bridge for a scope the caller built (Ask's
   * read-only sessions, docs/systems/ask.md). Null when tools cannot be
   * offered (see `bridgeUnavailableReason`). The caller closes it.
   */
  openBridge(scope: Omit<ToolScope, 'sessionId' | 'escalated'>, ttlMs: number): (AgentToolBridge & { sessionId: string }) | null {
    if (this.bridgeUnavailableReason()) return null;
    const session = this.d.tools.openSession(scope, 'agent', ttlMs);
    return {
      sessionId: session.id,
      command: process.execPath,
      args: [this.d.bridgePath!],
      env: { ACC_TOOL_URL: this.listenUrl!, ACC_TOOL_SESSION: session.token },
      close: () => this.d.tools.closeSession(session.id),
    };
  }

  /** "## Control Center tools" section appended to agent prompts. */
  toolsPromptSection(task: TaskRecord, def: StageDefinition, repo: RepositoryRecord): string {
    if (!this.stageToolsOffered() || !this.listenUrl) return '';
    const profile = def.toolProfile ?? profileForRepository(repo.tooling, def.permissionLevel);
    return [
      '## Control Center tools',
      '',
      `This run has the Control Center's tools as an MCP server named "acc" (profile: ${profile}, stage Level ${def.permissionLevel}, policy ${this.policyMode(task, repo)}).`,
      'Prefer them to raw commands for: checking the app in a real browser (browser.check_page, verify.web), HTTP checks (http.request), who holds a port (network.port_owner), background dev servers (process.start — stopped for you at the end), databases, Cloudflare, Android and GitHub.',
      VISUAL_LOOP_LINE,
      'Use acc_find_capability to discover more and acc_call_capability to call one that is not listed. A refusal explains why; do not work around it — report it as an operator decision.',
      // Claude Code has no shell at Level 1 (docs/systems/agents.md): Git reads go through these.
      ...(def.permissionLevel <= 1 ? ['Level 1 may give you no shell. Read Git with git__status, git__diff (from, to, paths — e.g. "git diff <base> -- <path>" is from=<base>, paths=[<path>]), git__log and git__show.'] : []),
      ...(taskRepositories(this.d.store, task).length > 1
        ? ['This task works in several repositories: a tool call runs in one of them. Pass `cwd` (or `directory`) naming the repository folder; the call can then touch only that repository and use only its credentials. At the workspace root, Git tools do not work and only credentials shared by every repository are available.']
        : []),
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
    if (def.permissionLevel <= 1 && this.installs.has(task.id)) parts.push(INSTALLING_PROMPT_SECTION);
    if (['investigate', 'plan', 'write'].includes(roleClass(def.role) ?? '') && def.role !== 'fixer') {
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
    // Listing the catalog is a cold CLI call: only a text that names a `/skill` (or a stage that lists skills) pays for it, never one with file paths only.
    if (!this.d.skills || (!mentionsSkillToken(text) && !def.skills?.length)) return '';
    const catalog = await this.d.skills.list(repo.path).catch(() => null);
    if (!catalog) return '';
    const byName = new Map(catalog.skills.map((s) => [s.name, s]));
    // Named by the operator (`/name`) or by the workflow for this stage (`skills`); only installed skills count.
    const names = [...new Set([...requestedSkills(text, new Set(byName.keys())), ...(def.skills ?? []).filter((n) => byName.has(n))])];
    if (!names.length) return '';
    return [
      '## Requested skills',
      '',
      def.skills?.length ? 'The operator (`/name` in the task or a directive) or this stage of the workflow asked for these skills:' : 'The operator asked for these skills by name (`/name` in the task or a directive):',
      ...names.map((name) => {
        const description = byName.get(name)?.description;
        return `- \`${name}\`${description ? ` — ${description}` : ''}`;
      }),
      '',
      `You are the ${def.role} in stage "${def.name}". Run a requested skill with your skill mechanism (the Skill tool in Claude Code) in the stage whose job it matches: skills that change code in implementation, design or fix stages; design, UI and media skills in design stages; review, audit and check skills in review or verification stages; investigation and planning skills in those stages. When no stage clearly fits, the implementation (or design build) stage runs it.`,
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
    return path.join(this.d.workDir, 'worktrees', slug);
  }

  /** The folder of a multi-repository task: one worktree per repository, side by side (docs/plans/MULTI_REPO_TASKS_PLAN.md). */
  workspaceRoot(task: Pick<TaskRecord, 'id'>): string {
    return path.join(this.d.workDir, 'workspaces', task.id);
  }

  /**
   * Once, at start (SEC-3): worktrees and task workspaces made before the work
   * root existed live in the data folder, whose path an agent may not name.
   * Each is moved to the work root and its task's record follows: a worktree
   * with `git worktree move`, a workspace (its worktrees and whatever the
   * agents left beside them) with one rename and `git worktree repair` of each
   * worktree in it, renamed back if a repair fails. Only paths still under the
   * old folders are looked at, so it is idempotent. A task whose move fails
   * keeps its folder and record (it runs from there as before) and is tried
   * again at the next start; one whose move a stop cut off after the folder
   * moved and before its record did is finished from where the folder is.
   */
  async relocateLegacyWorkFolders(): Promise<{ moved: string[]; kept: Array<{ taskId: string; reason: string }> }> {
    const report = { moved: [] as string[], kept: [] as Array<{ taskId: string; reason: string }> };
    const oldWorktrees = path.join(this.d.dataDir, 'worktrees');
    const oldWorkspaces = path.join(this.d.dataDir, 'workspaces');
    for (const task of this.d.store.tasksWithWorkFolders()) {
      const { workspacePath, worktreePath } = task.git;
      let kept: string | null;
      try {
        if (workspacePath) {
          if (!isInsidePath(oldWorkspaces, workspacePath)) continue;
          kept = await this.relocateWorkspace(task, workspacePath, path.join(this.d.workDir, 'workspaces', path.relative(oldWorkspaces, workspacePath)));
        } else if (worktreePath && isInsidePath(oldWorktrees, worktreePath)) {
          kept = await this.relocateWorktree(task, worktreePath, path.join(this.d.workDir, 'worktrees', path.relative(oldWorktrees, worktreePath)));
        } else continue;
      } catch (error) {
        kept = redact((error as Error).message).slice(0, 300);
      }
      if (kept) report.kept.push({ taskId: task.id, reason: kept });
      else report.moved.push(task.id);
    }
    return report;
  }

  /** Whether Git lists `dir` among `repoPath`'s worktrees. */
  private async listsWorktree(repoPath: string, dir: string): Promise<boolean> {
    const listed = (await git(repoPath, ['worktree', 'list', '--porcelain'])).stdout.split('\n').map((l) => (l.startsWith('worktree ') ? l.slice(9) : null));
    return listed.some((p) => p !== null && samePath(p, dir));
  }

  /**
   * Why the worktree stays where it is, or null once it moved and the task's
   * record says so. A start that stopped after the move and before the record
   * finishes here: the worktree Git already lists at `to` is taken as it is.
   */
  private async relocateWorktree(task: TaskRecord, from: string, to: string): Promise<string | null> {
    const repo = this.d.store.getRepository(task.repositoryId);
    if (!repo || !existsSync(repo.path)) return 'its repository is not on this disk';
    const resumed = !existsSync(from) && existsSync(to) && (await this.listsWorktree(repo.path, to));
    if (!resumed) {
      if (!existsSync(from)) return `${from} is missing`;
      if (existsSync(to)) return `${to} already exists`;
      mkdirSync(path.dirname(to), { recursive: true });
      const moved = await git(repo.path, ['worktree', 'move', from, to]);
      if (moved.code !== 0) return redact((moved.stderr || moved.stdout).trim()).slice(0, 300) || `git worktree move exited with ${moved.code}`;
    }
    this.d.store.updateTask(task.id, { git: { ...task.git, worktreePath: to } });
    await this.setAsideInstall(to);
    return null;
  }

  /**
   * Why the workspace stays where it is, or null once it and every worktree in
   * it moved and the records say so. A start that stopped after the rename and
   * before the records finishes here: the folder already at `to` is repaired
   * and taken, or left there with the reason when a repair fails.
   */
  private async relocateWorkspace(task: TaskRecord, from: string, to: string): Promise<string | null> {
    const resumed = !existsSync(from) && existsSync(to);
    if (!resumed) {
      if (!existsSync(from)) return `${from} is missing`;
      if (existsSync(to)) return `${to} already exists`;
    }
    const units = taskRepositories(this.d.store, task).filter((u) => u.git.worktreePath && isInsidePath(from, u.git.worktreePath));
    const inside = (p: string, root: string) => path.join(root, path.relative(from, p));
    if (!resumed) {
      mkdirSync(path.dirname(to), { recursive: true });
      await rename(from, to);
    }
    const repairAll = async (root: string): Promise<string | null> => {
      for (const u of units) {
        const dir = inside(u.git.worktreePath!, root);
        const repaired = await git(u.repo.path, ['worktree', 'repair', dir]);
        if (repaired.code !== 0 || !(await this.listsWorktree(u.repo.path, dir))) return `${u.repo.name}: ${redact((repaired.stderr || repaired.stdout).trim()).slice(0, 200) || 'git worktree repair did not take'}`;
      }
      return null;
    };
    const failed = await repairAll(to);
    // Found there, not moved there now: nothing of this start's to undo.
    if (failed && resumed) return `${failed}; the workspace is at ${to}`;
    if (failed) {
      // Everything back as it was: the folder, and each repository's record of its worktree.
      try {
        await rename(to, from);
      } catch (error) {
        return `${failed}; the workspace could not be moved back and is now at ${to} (${redact((error as Error).message).slice(0, 200)})`;
      }
      await repairAll(from);
      return failed;
    }
    const primary = task.git.worktreePath && isInsidePath(from, task.git.worktreePath) ? { worktreePath: inside(task.git.worktreePath, to) } : {};
    this.d.store.updateTask(task.id, { git: { ...task.git, workspacePath: to, ...primary } });
    for (const u of units) if (!u.primary) this.d.store.updateLinkedRepositoryGit(task.id, u.repo.id, { ...u.git, worktreePath: inside(u.git.worktreePath!, to) });
    for (const u of units) await this.setAsideInstall(inside(u.git.worktreePath!, to));
    return null;
  }

  /**
   * Dependencies the Control Center installed in a worktree that moved go to
   * the trash, so the task's next run installs them again from its lockfile:
   * links in them (pnpm's junctions on Windows) still name the old folder.
   * Only an install it made (its marker) is touched, never a tracked folder.
   */
  private async setAsideInstall(dir: string): Promise<void> {
    const modules = path.join(dir, 'node_modules');
    if (!existsSync(path.join(modules, INSTALL_MARKER))) return;
    try {
      await mkdir(this.trashRoot(), { recursive: true });
      const root = await this.plainTrashRoot();
      if (!root) throw new Error('no plain trash folder');
      await rename(modules, path.join(root, `${path.basename(dir)}-node_modules-${randomBytes(4).toString('hex')}`));
    } catch {
      // Left in place without its marker: the next run installs over it.
      await rm(path.join(modules, INSTALL_MARKER), { force: true }).catch(() => undefined);
    }
  }

  /**
   * One repository's worktree inside a task workspace. Unlike
   * `createWorktree` there is no fallback: a task across repositories is
   * isolated in every one of them, so a failure is thrown to the caller.
   * A folder left by an interrupted attempt (no record, so no agent ever ran
   * in it) is removed first.
   */
  async addWorkspaceWorktree(task: TaskRecord, repo: RepositoryRecord, dir: string): Promise<{ taskBranch: string; head: string }> {
    if (existsSync(dir)) {
      await removeWorktree(repo.path, dir, { force: true });
      // No agent ever ran there (no record), so its branch is still at HEAD and can go.
      const head = await headCommit(repo.path);
      if (head) await deleteBranchIfAt(repo.path, taskBranchName(task.id, task.title), head);
    }
    mkdirSync(path.dirname(dir), { recursive: true });
    const { branch, head } = await addWorktree(repo.path, dir, taskBranchName(task.id, task.title));
    this.event(task.id, 'WORKTREE_CREATED', `${repo.name}: working in an isolated worktree on ${branch}; your working tree is not touched`, { path: dir, branch, repositoryId: repo.id });
    return { taskBranch: branch, head };
  }

  /**
   * Create the task's worktree and branch. There is no fallback to the
   * operator's own checkout (AUTOPILOT_GATES_PLAN §3.F): a failure comes back
   * with its reason, and the task stops before any file is touched.
   */
  async createWorktree(task: TaskRecord, repo: RepositoryRecord): Promise<{ ok: true; worktreePath: string; taskBranch: string; head: string } | { ok: false; reason: string }> {
    if (!(await isGitRepository(repo.path))) return { ok: false, reason: `${repo.path} is not a Git repository` };
    const dir = path.join(this.worktreeRoot(repo), task.id);
    try {
      // A folder an interrupted attempt left behind (no record, so no agent ever ran in it) is cleared first.
      if (existsSync(dir)) {
        await removeWorktree(repo.path, dir, { force: true });
        const head = await headCommit(repo.path);
        if (head) await deleteBranchIfAt(repo.path, taskBranchName(task.id, task.title), head);
      }
      mkdirSync(path.dirname(dir), { recursive: true });
      const { branch, head } = await addWorktree(repo.path, dir, taskBranchName(task.id, task.title));
      this.event(task.id, 'WORKTREE_CREATED', `Working in an isolated worktree on ${branch}; your working tree is not touched`, { path: dir, branch });
      return { ok: true, worktreePath: dir, taskBranch: branch, head };
    } catch (error) {
      return { ok: false, reason: redact((error as Error).message).slice(0, 300) };
    }
  }

  /**
   * A fresh worktree has no dependencies installed; install them once from the
   * lockfile. Without a lockfile an install would write one into the task's
   * changes, so it is left to the test stage's repair instead. Done means the
   * marker (or npm's own proof), not "node_modules exists": a restart can
   * leave a half-filled folder.
   */
  async prepareWorktree(task: TaskRecord, repo: RepositoryRecord, cwd: string = taskWorkdir(task, repo), signal?: AbortSignal): Promise<void> {
    const marker = path.join(cwd, 'node_modules', INSTALL_MARKER);
    const pm = packageManager(cwd);
    if (!pm || installComplete(cwd, pm)) return;
    if (!LOCKFILES.some((f) => existsSync(path.join(cwd, f)))) {
      const key = `${task.id}|${cwd}`;
      if (!this.noLockfileAnnounced.has(key)) {
        this.noLockfileAnnounced.add(key);
        this.event(task.id, 'TOOL_CALL', 'No lockfile in the worktree: dependencies are installed when a check needs them', {});
      }
      return;
    }
    const outcome = await this.d.tools.invoke({ capability: 'node.install', input: { frozen: true }, origin: 'engine', scope: this.scope(task, repo, { level: 2, stageId: null, cwd }), preApproved: true, timeoutMs: 20 * 60_000, signal });
    // Without the marker the next run of the task installs again: slower, never wrong.
    if (outcome.result.ok && existsSync(path.dirname(marker))) await writeFile(marker, `${now()}\n`).catch(() => undefined);
    this.event(task.id, 'TOOL_CALL', `${outcome.result.ok ? 'Installed dependencies in the worktree' : 'Dependencies in the worktree were not installed'}: ${outcome.result.summary}`, { executionId: outcome.execution.id, ok: outcome.result.ok });
  }

  /**
   * Install the dependencies of the task's worktrees (one per repository,
   * in turn) in the background, so read-only stages run meanwhile; the engine
   * waits with `settleInstall` before anything that runs code or removes a
   * worktree. One install per task at a time. Its promise never rejects (Node
   * exits on an unhandled rejection): a failure is logged and the task goes on,
   * as it did when the install was awaited up front.
   */
  startInstall(task: TaskRecord, units: Array<{ repo: RepositoryRecord; cwd: string }>): void {
    if (this.installs.has(task.id) || !units.length) return;
    const controller = new AbortController();
    const run = async () => {
      try {
        for (const unit of units) {
          if (controller.signal.aborted) return;
          await this.prepareWorktree(task, unit.repo, unit.cwd, controller.signal).finally(() => this.d.tools.forgetFolder(unit.cwd));
        }
      } catch (error) {
        try {
          this.event(task.id, 'TOOL_CALL', `Dependencies in the worktree were not installed: ${redact((error as Error)?.message ?? String(error)).slice(0, 200)}`, { ok: false });
        } catch {
          /* the database is closing */
        }
      }
    };
    const done = run().finally(() => this.installs.delete(task.id));
    this.installs.set(task.id, { done, controller });
  }

  /** Whether the task's background install is still running. */
  installRunning(taskId: string): boolean {
    return this.installs.has(taskId);
  }

  /**
   * Wait for the task's background install, if one runs. Returns whether there
   * was one to wait for. Never rejects.
   */
  async settleInstall(taskId: string): Promise<boolean> {
    const install = this.installs.get(taskId);
    if (!install) return false;
    await install.done;
    return true;
  }

  /**
   * Stop every background install (the orchestrator is shutting down). Its
   * worktree is kept without the marker, so the next run installs it again.
   */
  abortInstalls(): void {
    for (const install of this.installs.values()) install.controller.abort();
  }

  /**
   * Install dependencies in a throwaway checkout outside the task's own folder
   * (a baseline check, AUTOPILOT_GATES_PLAN §3.B), from its lockfile only,
   * through the tool policy with a scope confined to that folder.
   */
  async prepareDetached(task: TaskRecord, repo: RepositoryRecord, dir: string): Promise<{ ok: boolean; summary: string }> {
    if (!packageManager(dir) || existsSync(path.join(dir, 'node_modules'))) return { ok: true, summary: 'nothing to install' };
    if (!LOCKFILES.some((f) => existsSync(path.join(dir, f)))) return { ok: true, summary: 'no lockfile: nothing installed' };
    // One folder, one repository: never the task's workspace list, whose narrowing would refuse a folder outside it.
    const { repositories: _r, ...base } = this.scope(task, repo, { level: 2, stageId: null, cwd: dir });
    const scope = { ...base, roots: [dir], protectedPaths: [] };
    const outcome = await this.d.tools.invoke({ capability: 'node.install', input: { frozen: true }, origin: 'engine', scope, preApproved: true, timeoutMs: 20 * 60_000 });
    return { ok: outcome.result.ok, summary: outcome.result.summary };
  }

  /**
   * Finish an isolated task: commit what it left uncommitted to its branch
   * (completed), or keep it in a checkpoint ref (cancelled), then take the
   * worktree away — moved to the trash at once, deleted later by `emptyTrash`
   * (`moveToTrash`), or removed in place when it cannot be moved. The branch
   * stays for you to merge.
   */
  async finalizeWorktree(task: TaskRecord, repo: RepositoryRecord, outcome: 'completed' | 'cancelled', gitRecord: TaskRecord['git'] = task.git, label: string | null = null): Promise<Partial<TaskRecord['git']>> {
    // A task across repositories finalizes each repository's worktree with its own Git record.
    const git = gitRecord;
    const who = label ? `${label}: ` : '';
    const dir = git.worktreePath;
    if (!dir) return {};
    const patch: Partial<TaskRecord['git']> = {};
    try {
      const baseline = git.baselineSnapshotId ? this.d.store.getSnapshot(git.baselineSnapshotId) : null;
      const files = baseline && existsSync(dir) ? await changesSince(dir, baseline) : [];
      const pending = files.filter((f) => f.origin === 'task').map((f) => f.path);
      if (pending.length && outcome === 'completed') {
        const commit = await commitPaths(dir, pending, `${task.id}: ${task.title}\n\nRemaining changes, committed when the task completed (AI Development Control Center).`);
        if (commit) {
          patch.commits = [...git.commits, commit];
          this.event(task.id, 'GIT_COMMIT', `${who}Committed ${pending.length} remaining file(s) on ${git.taskBranch} (${commit.slice(0, 10)})`, { commit, files: pending, repositoryId: repo.id });
        }
      } else if (pending.length) {
        const ref = `refs/acc/worktree-backup/${task.id}`;
        const cp = await createCheckpoint(dir, ref, `${task.id}: uncommitted work when the task was cancelled`);
        this.event(task.id, 'CHECKPOINT_CREATED', `${who}Kept ${pending.length} uncommitted file(s) in ${ref} (${cp.commit.slice(0, 10)}) before removing the worktree`, { ref, commit: cp.commit });
      }
      const force = outcome === 'cancelled' || pending.length > 0;
      const removed = (await this.moveToTrash(repo.path, dir, force)) || (await removeWorktree(repo.path, dir, { force }));
      if (removed) {
        patch.worktreePath = null;
        this.event(task.id, 'WORKTREE_REMOVED', `${who}Worktree removed; the work is on branch ${git.taskBranch}${outcome === 'completed' ? ' — merge it from Source Control' : ''}`, { branch: git.taskBranch, repositoryId: repo.id });
      }
    } catch (error) {
      this.event(task.id, 'WORKTREE_REMOVED', `${who}The worktree could not be cleaned up: ${redact((error as Error).message).slice(0, 200)}. It is kept at ${dir}.`, {});
    }
    return patch;
  }

  /** Where finished worktrees wait for deletion: in the work root, so on the worktrees' drive and a rename away. */
  trashRoot(): string {
    return path.join(this.d.workDir, 'trash');
  }

  /**
   * The trash folder under `base` (the work root, or the data folder where
   * finished worktrees waited before the work root existed: only emptied,
   * never moved into), only when it is a plain folder right where it belongs.
   * Were it a link (a junction on Windows), moving into it or emptying it
   * would act on whatever it points at, with the orchestrator's rights. Null
   * when it is missing or not plain; the caller then leaves it alone.
   */
  private async plainTrashRoot(base: string = this.d.workDir): Promise<string | null> {
    const root = path.join(base, 'trash');
    try {
      const stat = await lstat(root);
      if (stat.isDirectory() && !stat.isSymbolicLink() && (await realpath(root)) === path.join(await realpath(base), 'trash')) return root;
    } catch {
      return null;
    }
    console.warn(`[trash] ${root} is not a plain folder (a link?): it is neither used nor emptied, and finished worktrees are removed in place`);
    return null;
  }

  /**
   * Take a finished worktree out of its repository at once: rename its folder
   * into the trash and prune Git's record of it, so deleting node_modules no
   * longer holds up the task (~11 s on a large repository). False — the caller
   * then removes it in place, as before — when it cannot be renamed (a locked
   * file, a process still inside on Windows) or, without `force`, when it
   * still has changes `git worktree remove` would refuse to drop.
   */
  private async moveToTrash(repoPath: string, dir: string, force: boolean): Promise<boolean> {
    if (!existsSync(dir)) return false;
    if (!force) {
      const changes = await status(dir).catch(() => null);
      if (changes === null || changes.length > 0) return false;
    }
    try {
      await mkdir(this.trashRoot(), { recursive: true });
      const root = await this.plainTrashRoot();
      if (!root) return false;
      await rename(dir, path.join(root, `${path.basename(path.dirname(dir))}-${path.basename(dir)}-${randomBytes(4).toString('hex')}`));
    } catch {
      return false;
    }
    await git(repoPath, ['worktree', 'prune']).catch(() => undefined);
    return true;
  }

  /**
   * Delete everything in the trash, in the background; one sweep at a time (a
   * request during a sweep runs it again). It touches only the trash folder,
   * only while that is a plain folder (`plainTrashRoot`), and `fs.rm` removes
   * a link inside it — a junction on Windows — without following it. Never
   * rejects: what cannot be deleted now waits for the next sweep, at the
   * latest the one at start. Returns how many entries went.
   */
  emptyTrash(): Promise<number> {
    if (this.trashSweep) {
      this.trashAgain = true;
      return this.trashSweep;
    }
    const sweep = async (): Promise<number> => {
      let removed = 0;
      do {
        this.trashAgain = false;
        // The work root's trash, and the data folder's from before it existed (SEC-3).
        for (const base of [this.d.workDir, this.d.dataDir]) {
          const root = await this.plainTrashRoot(base);
          if (!root) continue;
          for (const name of await readdir(root).catch(() => [] as string[])) {
            // Checked again before each entry: a link swapped in mid-sweep is not followed either.
            if (!(await this.plainTrashRoot(base))) break;
            try {
              await rm(path.join(root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
              removed++;
            } catch {
              /* locked: the next sweep tries again */
            }
          }
        }
      } while (this.trashAgain);
      return removed;
    };
    this.trashSweep = sweep()
      .catch(() => 0)
      .finally(() => {
        this.trashSweep = null;
        // Asked for between the last pass and now: run once more.
        if (this.trashAgain) void this.emptyTrash();
      });
    return this.trashSweep;
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

  /** An agent stage ended: stop the background processes it started, so the next stage finds its ports free. */
  async stopStageProcesses(taskId: string, stage: StageInstance, stageName: string): Promise<void> {
    const names = await this.d.processes.stopForStage(taskId, stage.id, `${stageName} ended`).catch(() => [] as string[]);
    const terminals = await this.d.terminals.closeForStage(taskId, stage.id).catch(() => 0);
    const parts = [...(names.length ? [`stopped ${names.length} background process(es) (${names.join(', ')})`] : []), ...(terminals ? [`closed ${terminals} terminal(s)`] : [])];
    if (parts.length) this.event(taskId, 'PROCESS_STOPPED', `${stageName} ended: ${parts.join(' and ')} it left running`, { names, terminals }, stage.id);
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
    if (ok('verify.web') || ok('browser.check_page') || ok('browser.run_flow') || ok('browser.visual_matrix') || ok('browser.accessibility')) observed.add('browser');
    if (ok('http.') || ok('verify.web')) observed.add('http');
    if (ok('android.launch')) observed.add('device');
    const units = taskRepositories(this.d.store, task);
    if (units.length <= 1) {
      const type = projectType(repo.tooling);
      const assessment = assessVerification(type, { passedKinds, observed });
      return { type, satisfied: assessment.satisfied.map((c) => c.label), missing: assessment.missing.map((c) => `${c.label}${c.advisory ? ' (optional)' : ''}`) };
    }
    // Across repositories: each is assessed on its own checks; one with none configured says so.
    const out = { types: [] as string[], satisfied: [] as string[], missing: [] as string[] };
    for (const unit of units) {
      const label = unit.folder ?? unit.repo.name;
      const kinds = new Set<CommandKind>(testRuns.filter((r) => r.status === 'passed' && r.repositoryId === unit.repo.id && (r.stageId === lastTests?.id || r.kind === 'e2e')).map((r) => r.kind));
      const type = projectType(unit.repo.tooling);
      const assessment = assessVerification(type, { passedKinds: kinds, observed });
      out.types.push(`${label}: ${type}`);
      out.satisfied.push(...assessment.satisfied.map((c) => `${label}: ${c.label}`));
      if (!unit.repo.commands.some((c) => c.enabled)) out.missing.push(`${label}: no checks configured`);
      out.missing.push(...assessment.missing.map((c) => `${label}: ${c.label}${c.advisory ? ' (optional)' : ''}`));
    }
    return { type: out.types.join(', '), satisfied: out.satisfied, missing: out.missing };
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
