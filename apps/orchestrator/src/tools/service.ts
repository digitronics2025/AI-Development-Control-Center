import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GuardedFileTool } from '@acc/agent-claude';
import { resolveShell, type ShellInfo, type ShellKind } from '@acc/executor';
import {
  classifyCommand,
  constantTimeEqual,
  describeFindings,
  inputReferencesSelf,
  knownSecretValues,
  maskPersonalData,
  maskPersonalText,
  namedHost,
  redact,
  REDACTED,
  referencesSelf,
  relativizeOwnRoots,
  sanitizeEnv,
  scanOutbound,
  type OutboundFinding,
  type OutboundSecret,
} from '@acc/security';
import type { CapabilityView, EventType, PermissionLevel, PolicyMode, ToolCallOrigin, ToolExecution, ToolExecutionStatus, ToolView } from '@acc/shared';
import {
  builtinProviders,
  classifyScript,
  decide,
  isInside,
  policyCeiling,
  PROFILES,
  profileIncludes,
  profileRank,
  realish,
  resolveInside,
  ToolHealthCache,
  ToolRegistry,
  ToolRouter,
  type ArtifactSink,
  type CheckpointHost,
  type OperationContext,
  type OperationResult,
  type PolicyDecision,
  type ProfileId,
  type ToolDetection,
  type ToolOperation,
  type ToolProvider,
  type ToolRisk,
} from '@acc/tools';
import { z } from 'zod';
import type { Bus } from '../bus.js';
import { learnedPluginsRoot } from '../learning/skills.js';
import type { ArtifactService } from '../services/artifacts.js';
import type { SettingsService } from '../services/settings.js';
import { newId, now } from '../store/store.js';
import type { VaultDepositService } from './vault-deposit.js';
import type { MediaSpendGate } from '../usage/media.js';
import type { CredentialBroker } from './credentials.js';
import type { ProcessManager } from './processes.js';
import type { ToolStore } from './store.js';
import type { TerminalService } from './terminals.js';

/** Everything a call is allowed to see and do, fixed when a session or engine call is set up. */
export interface ToolScope {
  taskId: string | null;
  stageId: string | null;
  sessionId: string | null;
  repositoryId: string | null;
  cwd: string;
  roots: string[];
  /** The stage's own level; operator sessions use the policy ceiling. */
  stageLevel: PermissionLevel;
  autoApproveUpToLevel: PermissionLevel;
  mode: PolicyMode;
  profile: ProfileId;
  /** Capabilities enabled by escalation in this scope. */
  escalated: Set<string>;
  protectedPaths: string[];
  /**
   * The commit the task started from in this scope's repository (its baseline),
   * for tools that compare against it (`security.*`, VER-1); absent outside a
   * task or without Git.
   */
  baseline?: string | null;
  /**
   * A task across repositories (docs/plans/MULTI_REPO_TASKS_PLAN.md): its
   * repositories, their folders in the workspace and each one's baseline
   * commit. Each call is narrowed to the repository its folder names (`narrowToRepository`).
   */
  repositories?: Array<{ id: string; root: string; baseline?: string | null }>;
  /**
   * A read-only session (docs/systems/ask.md). Only capabilities on `allow`
   * run, and only calls that cannot change anything; everything else is
   * denied, never escalated. Credentials are the pinned ones or none.
   */
  readOnly?: ReadOnlyScope;
  /**
   * A design stage's session (the designer role, or the frontend-design profile): outside MCP tools are refused at
   * every level. They declare no cost, so the spend gate could not see what a generation server bills
   * (docs/plans/DESIGNER_ROUTING_PLAN.md §5); paid media goes through the spend-gated `media.*` tools only.
   */
  designSession?: boolean;
}

/** Why a design stage may not call an outside MCP tool: shown to the agent and in the escalation log. */
export const DESIGN_MCP_REFUSAL =
  'Design stages cannot call outside MCP tools: they declare no cost, so the spend gate cannot check what they bill. Use the Control Center media.* tools, or report it as an operator decision.';

export interface ReadOnlyScope {
  allow: ReadonlySet<string>;
  /** Credential kind → credential name. A kind without a pin has no credential at all. */
  credentials: Partial<Record<string, string>>;
  /** Plain settings the read packs need (CLOUDFLARE_ACCOUNT_ID, ACC_GITHUB_OWNERS); never secrets. */
  env: Record<string, string>;
  /** Mask personal data in what the model sees and what is stored. */
  maskPersonal: boolean;
  /** Calls one session may make; the next is denied. */
  maxCalls: number;
  /** Calls made so far (mutable). */
  calls: { count: number };
}

/**
 * In a task across repositories, a call runs in one repository: the one
 * containing the folder it names (its `cwd`, else its `directory`, else
 * the scope's cwd). Its roots shrink to that repository's folder, so nothing
 * it touches is in another repository, and it is given that repository's
 * credentials only. A call in no repository (the workspace root) keeps the
 * workspace as its root and may use only credentials scoped to every
 * repository. Fails closed: a folder outside the roots is refused.
 */
export function narrowToRepository(scope: ToolScope, rawInput: unknown): { scope: ToolScope; input: unknown } | { error: string } {
  if (!scope.repositories?.length) return { scope, input: rawInput };
  const raw = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  const field = typeof raw.cwd === 'string' && raw.cwd ? 'cwd' : typeof raw.directory === 'string' && raw.directory ? 'directory' : null;
  let target = scope.cwd;
  if (field) {
    try {
      target = resolveInside(scope.roots, scope.cwd, raw[field] as string);
    } catch (error) {
      return { error: (error as Error).message };
    }
  }
  const repo = scope.repositories.find((r) => isInside(r.root, target));
  if (!repo) return { scope: { ...scope, repositoryId: null, baseline: null }, input: rawInput };
  return { scope: { ...scope, repositoryId: repo.id, cwd: repo.root, roots: [repo.root], baseline: repo.baseline ?? null }, input: field ? { ...raw, [field]: target } : rawInput };
}

export interface ToolCallRequest {
  capability: string;
  input: unknown;
  origin: ToolCallOrigin;
  scope: ToolScope;
  /** The caller already obtained a person's decision (engine approval gate, typed confirmation). */
  preApproved?: boolean;
  preferProvider?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  onLine?: OperationContext['onLine'];
  attempt?: number;
  recoveryOf?: string | null;
}

export interface ToolCallOutcome {
  execution: ToolExecution;
  result: OperationResult;
  decision: PolicyDecision['decision'];
}

export interface ToolSession {
  id: string;
  token: string;
  scope: ToolScope;
  kind: 'agent' | 'operator';
  createdAt: string;
  expiresAt: number;
  /** Opened only for the native shell precheck (tools are off for agents): no tool route accepts it. */
  guardOnly?: boolean;
}

/** Claude Code's settings files, through which a command could switch the precheck hook off (`disableAllHooks`). */
const NAMES_CLAUDE_SETTINGS = /\.claude[\\/]+settings[^\\/\s"'`]*\.json/i;

/** The native precheck's answer to the run's hook (SEC-3). */
export type NativeDecision = { decision: 'allow' } | { decision: 'deny'; reason: string };

/** The input fields that name what each guarded native file tool reads (Grep's `pattern` is text to find, not a path). */
export const NATIVE_FILE_PATHS: Readonly<Record<GuardedFileTool, readonly string[]>> = { Read: ['file_path'], Grep: ['path', 'glob'], Glob: ['path', 'pattern'] };

/** A native call no approval can let through: Level 5, dangerous. */
function dangerous(reason: string, effect: ToolRisk['effects'][number]): ToolRisk {
  return { level: 5, risk: 'dangerous', reasons: [reason], effects: [effect], production: false };
}

/** The task's own folders, which a call may name as its own (`relativizeOwnRoots`): its roots, working folder and linked repositories. */
function ownRoots(scope: ToolScope): string[] {
  return [...scope.roots, scope.cwd, ...(scope.repositories ?? []).map((r) => r.root)];
}
/** A path segment `..`: a read-only folder's mention followed by one leaves the folder. */
const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/**
 * A mention of the absolute folder `root` in a command, in its own spelling or
 * Git Bash's (`/c/Users/…` for `C:\Users\…`), with the rest of that path as
 * group 1; null for a root that names no folder.
 */
function folderMention(root: string, flags: string): RegExp | null {
  const parts = root.split(/[\\/]+/).filter(Boolean);
  const drive = /^[A-Za-z]:$/.test(parts[0] ?? '') ? parts.shift()!.slice(0, 1) : null;
  if (!parts.length) return null;
  const head = drive ? `(?:${drive}:|[\\\\/]${drive}(?=[\\\\/]))` : '';
  const body = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+');
  return new RegExp(`${head}[\\\\/]+${body}(?![^\\\\/\\s"'\`|;&<>])((?:[\\\\/][^\\s"'\`|;&<>]*)?)`, flags);
}

/**
 * `command` with each mention of a folder agents may read but never write
 * (the learned plugins, which live in the data folder) put as a neutral word,
 * so that folder alone does not make the command a self-reference (SEC-3).
 * The caller uses the result only for a command that then reads and nothing
 * more; a mention followed by a `..` segment is kept as it is.
 */
export function excuseReadOnlyFolders(command: string, roots: readonly string[]): string {
  let out = command;
  for (const root of roots) {
    const mention = folderMention(root, 'gi');
    if (mention) out = out.replace(mention, (whole, tail: string) => (PARENT_SEGMENT.test(tail) ? whole : `learned-plugins${tail}`));
  }
  return out;
}

/**
 * Whether `command` names the native shell check (SEC-3): its script by file
 * name, whatever the path before it, or its folder by absolute path. The run's
 * Edit rule on that folder (`shellGuardDenied`) covers the file tools and
 * redirections; this covers the rest of a shell command's ways to change it.
 */
export function namesShellGuard(command: string, script: string): boolean {
  const name = path.basename(script).replace(/\.[^.]*$/, '').toLowerCase();
  return (name !== '' && command.toLowerCase().includes(name)) || Boolean(folderMention(path.dirname(script), 'i')?.test(command));
}

/** Capabilities agents already have natively (their own Read/Edit/Bash and git): callable, but not listed, to keep prompts small. */
const NATIVE_OVERLAP = /^(?:fs\.|shell\.|process\.exec$|git\.(?:status|diff|log|show|branch_list|stage)$)/;
const MAX_LISTED = 60;
/** Capabilities that put a stored secret where it is used. Only a production put (Level 5, always a typed approval) may read a reserved one. */
const SECRET_DEPLOYS: ReadonlySet<string> = new Set(['cloudflare.secret_put', 'github.secret_put']);

/** A call's input as it is recorded: redacted and clipped; a string (or key) `masked` names is recorded as `[REDACTED]`. */
function clipInput(input: unknown, masked?: (text: string) => boolean): string {
  const shrink = (v: unknown): unknown => {
    if (typeof v === 'string') return v.length > 300 ? `[${v.length} characters]` : masked?.(v) ? REDACTED : v;
    if (Array.isArray(v)) return v.slice(0, 20).map(shrink);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [masked?.(k) ? REDACTED : k, shrink(x)]));
    return v;
  };
  const text = redact(JSON.stringify(shrink(input)) ?? '');
  return text.length > 800 ? `${text.slice(0, 799)}…` : text;
}

/** `name (type, required), …` from a JSON Schema's properties, 600 characters at most. */
export function inputSummary(schema: Record<string, unknown>): string {
  const props = (schema.properties ?? {}) as Record<string, { type?: unknown; description?: unknown }>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const parts = Object.entries(props).map(([name, p]) => `${name} (${typeof p?.type === 'string' ? p.type : 'any'}${required.has(name) ? ', required' : ''})`);
  const text = parts.length ? parts.join(', ') : 'an object';
  return text.length > 600 ? `${text.slice(0, 599)}…` : text;
}

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  try {
    const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
    delete out.$schema;
    return out;
  } catch {
    return { type: 'object' };
  }
}

function statusOf(result: OperationResult): ToolExecutionStatus {
  if (result.ok) return 'succeeded';
  if (result.error?.code === 'TIMEOUT') return 'timed_out';
  if (result.error?.code === 'CANCELLED') return 'cancelled';
  return 'failed';
}

export interface ToolServiceDeps {
  toolStore: ToolStore;
  bus: Bus;
  settings: SettingsService;
  artifacts: ArtifactService;
  processes: ProcessManager;
  terminals: TerminalService;
  credentials: CredentialBroker;
  /** MyVault's delivery box: lets a newly generated secret be saved for MyVault while it is locked. */
  deposits?: VaultDepositService;
  /** The spend gate for paid calls (docs/systems/design-agent.md); without it a paid call never runs. */
  spend?: MediaSpendGate;
  dataDir: string;
  baseEnv: NodeJS.ProcessEnv;
  /** The native shell precheck hook's script (SEC-3), which the precheck keeps agents from changing (`namesShellGuard`). */
  shellGuardPath?: string | null;
  /** The local API token: the outbound check names it when a request would carry it (SEC-4). */
  localToken?: string | null;
}

/** What an outbound request would carry where it may not go (SEC-4): by kind, name and host, never a value. */
export interface OutboundLeak {
  reason: string;
  /** A stored credential attached by name to a host outside its audience. */
  audience: Array<{ kind: string; name: string; host: string }>;
  /** Known secrets and token formats in what the caller wrote. */
  findings: OutboundFinding[];
}

/**
 * The execution authority (V2 plan §5.1): every tool call — from an agent
 * over MCP, from the engine, from the dashboard or the Chairman — passes
 * through `invoke`. It routes the capability to a provider, classifies the
 * concrete call, applies the task's policy, injects brokered credentials,
 * takes a checkpoint before high-impact work, runs it, redacts the result
 * and records a `tool_executions` row plus a realtime event.
 */
export class ToolService {
  readonly registry = new ToolRegistry();
  readonly router: ToolRouter;
  readonly health: ToolHealthCache;
  private readonly shells = new Map<ShellKind, Promise<ShellInfo | null>>();
  private readonly sessions = new Map<string, ToolSession>();
  private readonly failures = new Map<string, Map<string, number>>();
  /** Detections made in a repository folder (project-local binaries), by `provider|folder`. */
  private readonly folderDetections = new Map<string, { at: number; detection: ToolDetection }>();
  private events: (taskId: string, type: EventType, message: string, data?: Record<string, unknown>, stageId?: string | null) => void = () => undefined;
  private checkpointsFor: (taskId: string) => CheckpointHost | undefined = () => undefined;
  private releaseBranchOf: (repositoryId: string) => string | null = () => null;
  private privileged: OperationContext['privileged'];

  constructor(private readonly d: ToolServiceDeps) {
    for (const p of builtinProviders()) this.registry.register(p);
    this.router = new ToolRouter(this.registry);
    this.health = new ToolHealthCache(this.registry, () => ({ env: this.env(), cwd: null, shell: (k) => this.shell(k), tempDir: this.tempDir() }), {
      ttlMs: 6 * 3600_000,
      onUpdate: (record) => {
        this.d.toolStore.saveHealth(record);
        const view = this.toolView(record.providerId);
        if (view) this.d.bus.publish({ type: 'tool', tool: view });
      },
    });
    this.health.seed(this.d.toolStore.loadHealth());
    this.syncRegistry();
  }

  /**
   * Late wiring: the engine's event publisher and the Chairman's checkpoints exist after this service.
   * `releaseBranch` names the branch a push to which deploys a repository (its release setting), read
   * at each call so a changed setting applies at once.
   */
  attach(opts: { events?: ToolService['events']; checkpoints?: (taskId: string) => CheckpointHost | undefined; privileged?: OperationContext['privileged']; releaseBranch?: (repositoryId: string) => string | null }): void {
    if (opts.events) this.events = opts.events;
    if (opts.checkpoints) this.checkpointsFor = opts.checkpoints;
    if (opts.privileged) this.privileged = opts.privileged;
    if (opts.releaseBranch) this.releaseBranchOf = opts.releaseBranch;
  }

  /**
   * Branches a push to which deploys what this call can reach: its
   * repository's release branch and, in a multi-repository task, every
   * repository's — a shell in one of them can `cd ../other` or `git -C
   * ../other push` as easily as one at the workspace root.
   */
  private releaseBranchesOf(scope: ToolScope): string[] {
    const ids = [...(scope.repositoryId ? [scope.repositoryId] : []), ...(scope.repositories ?? []).map((r) => r.id)];
    return [...new Set(ids.flatMap((id) => this.releaseBranchOf(id) ?? []))];
  }

  registerProvider(provider: ToolProvider, source = 'builtin'): void {
    this.registry.register(provider);
    this.syncRegistry(source);
  }

  unregisterProvider(id: string): void {
    this.registry.unregister(id);
    this.syncRegistry();
  }

  private syncRegistry(source = 'builtin'): void {
    this.d.toolStore.syncRegistry(
      this.registry.listProviders().map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        builtin: Boolean(p.builtin),
        source: p.id.startsWith('mcp:') ? 'mcp' : source,
        capabilities: p.operations.map((o) => ({ id: o.id, level: o.level })),
      })),
    );
  }

  env(): NodeJS.ProcessEnv {
    return sanitizeEnv(this.d.baseEnv, this.d.settings.get().billingMode).env;
  }

  shell(kind: ShellKind): Promise<ShellInfo | null> {
    let cached = this.shells.get(kind);
    if (!cached) {
      cached = resolveShell(kind, this.d.baseEnv);
      this.shells.set(kind, cached);
    }
    return cached;
  }

  tempDir(): string {
    const dir = path.join(this.d.dataDir, 'tmp');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  stateDir(): string {
    const dir = path.join(this.d.dataDir, 'tool-state');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ===========================================================================
  // Tool manager views
  // ===========================================================================

  toolView(id: string): ToolView | null {
    const p = this.registry.provider(id);
    if (!p) return null;
    const h = this.health.get(id);
    const usage = this.d.toolStore.usage().get(id);
    const unsupported = Boolean(p.platforms && !p.platforms.includes(process.platform));
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      category: p.category,
      builtin: Boolean(p.builtin),
      platforms: p.platforms ? [...p.platforms] : null,
      unsupported,
      state: p.builtin && !h ? 'ready' : (h?.state ?? 'unchecked'),
      installed: p.builtin ? (h?.installed ?? true) : Boolean(h?.installed),
      version: h?.version ?? null,
      path: h?.path ?? null,
      message: unsupported ? `Not available on ${process.platform}` : (h?.message ?? null),
      auth: h?.auth ?? { required: Boolean(p.checkAuth), state: p.checkAuth ? 'unknown' : 'not_required', message: null },
      checkedAt: h?.checkedAt ?? null,
      authCheckedAt: h?.authCheckedAt ?? null,
      capabilities: p.operations.map((o) => ({ id: o.id, title: o.title, level: o.level })),
      lastUsedAt: usage?.lastUsedAt ?? null,
      uses: usage?.uses ?? 0,
    };
  }

  tools(): ToolView[] {
    return this.registry
      .listProviders()
      .map((p) => this.toolView(p.id)!)
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  capabilities(): CapabilityView[] {
    return this.registry.capabilities();
  }

  async check(id: string, opts: { auth?: boolean } = {}): Promise<ToolView> {
    await this.health.check(id, { force: true, auth: opts.auth });
    return this.toolView(id)!;
  }

  /** Detect what is stale (never on every request; results are cached for hours). */
  refreshStale(): Promise<unknown> {
    return this.health.refresh({ platform: process.platform });
  }

  // ===========================================================================
  // Invocation
  // ===========================================================================

  private record(e: ToolExecution): void {
    this.d.toolStore.insertExecution(e);
    this.d.bus.publish({ type: 'toolExecution', execution: e });
  }

  private finish(e: ToolExecution, result: OperationResult, started: number): ToolExecution {
    const done = this.d.toolStore.finishExecution(e.id, {
      status: statusOf(result),
      summary: redact(result.summary).slice(0, 500),
      errorCode: result.error?.code ?? null,
      artifacts: result.artifacts ?? [],
      filesChanged: (result.filesChanged ?? []).slice(0, 200),
      networkTargets: (result.networkTargets ?? []).slice(0, 50),
      evidence: (result.evidence ?? []).map((l) => redact(l).slice(0, 400)).slice(0, 50),
      finishedAt: now(),
      durationMs: Date.now() - started,
    });
    this.d.bus.publish({ type: 'toolExecution', execution: done });
    return done;
  }

  private escalate(scope: ToolScope, capability: string, decision: 'enabled' | 'denied' | 'approval', reason: string, level: PermissionLevel): void {
    const row = { id: newId(), taskId: scope.taskId, stageId: scope.stageId, sessionId: scope.sessionId, capability, decision, reason: redact(reason).slice(0, 500), permissionLevel: level, createdAt: now() };
    this.d.toolStore.insertEscalation(row);
    const { sessionId: _s, ...escalation } = row;
    this.d.bus.publish({ type: 'escalation', escalation });
    if (scope.taskId) {
      const verb = decision === 'enabled' ? 'enabled' : decision === 'approval' ? 'needs approval' : 'refused';
      this.events(scope.taskId, 'CAPABILITY_ESCALATED', `Capability ${capability} ${verb}: ${row.reason}`, { capability, decision }, scope.stageId);
    }
  }

  private baseRisk(level: PermissionLevel, title: string): ToolRisk {
    return { level, risk: 'normal', reasons: [title], effects: [], production: false };
  }

  async invoke(req: ToolCallRequest): Promise<ToolCallOutcome> {
    let scope = req.scope;
    const started = Date.now();
    const base: Omit<ToolExecution, 'status' | 'decision' | 'permissionLevel' | 'risk' | 'effects' | 'summary' | 'errorCode'> = {
      id: newId(),
      taskId: scope.taskId,
      stageId: scope.stageId,
      sessionId: scope.sessionId,
      capability: req.capability,
      providerId: null,
      origin: req.origin,
      routeReason: null,
      inputSummary: clipInput(req.input),
      attempt: req.attempt ?? 1,
      recoveryOf: req.recoveryOf ?? null,
      artifacts: [],
      filesChanged: [],
      networkTargets: [],
      evidence: [],
      startedAt: now(),
      finishedAt: null,
      durationMs: null,
    };
    const refuse = (status: ToolExecutionStatus, code: NonNullable<OperationResult['error']>['code'], message: string, decision: PolicyDecision['decision'], risk: ToolRisk = this.baseRisk(1, req.capability)): ToolCallOutcome => {
      const execution: ToolExecution = { ...base, status, decision, permissionLevel: risk.level, risk: risk.risk, effects: risk.effects, summary: redact(message).slice(0, 500), errorCode: code, finishedAt: now(), durationMs: Date.now() - started };
      this.record(execution);
      return { execution, result: { ok: false, summary: message, error: { code, message } }, decision };
    };

    // 0. A task across repositories: the call belongs to the repository its folder names.
    const narrowed = narrowToRepository(scope, req.input);
    if ('error' in narrowed) return refuse('failed', 'OUTSIDE_ROOT', narrowed.error, 'deny');
    scope = narrowed.scope;
    // The workspace root is not a repository; Git there would search upward into whatever repository holds the data folder.
    if (scope.repositories?.length && !scope.repositoryId && req.capability.startsWith('git.')) {
      return refuse('failed', 'INVALID_INPUT', 'This task works in several repositories: set cwd to the folder of the repository to run Git in', 'deny');
    }
    const rawInput = narrowed.input;

    // A read-only session names what it may call; nothing else is routed, detected or escalated.
    if (scope.readOnly) {
      if (!scope.readOnly.allow.has(req.capability)) {
        this.escalate(scope, req.capability, 'denied', 'Not available in a read-only conversation', 1);
        return refuse('denied', 'DENIED', `${req.capability} is not available in this read-only conversation.`, 'deny');
      }
      if (scope.readOnly.calls.count >= scope.readOnly.maxCalls) {
        return refuse('denied', 'DENIED', `Lookup limit reached (${scope.readOnly.maxCalls} per answer). Answer from what you have.`, 'deny');
      }
      scope.readOnly.calls.count += 1;
    }

    // 1. Route the capability to a provider available here.
    const prefer = req.preferProvider ?? (typeof (req.input as { shell?: unknown })?.shell === 'string' ? ((req.input as { shell: string }).shell as string) : null);
    let route = this.router.route({ capability: req.capability, detection: (id) => this.health.get(id), prefer, failures: scope.taskId ? this.failures.get(scope.taskId) : undefined });
    if (!route.ok && route.code === 'NOT_INSTALLED') {
      // Detection is lazy: providers never checked yet are checked now, once, then routing is retried.
      const unchecked = this.registry.offering(req.capability).filter((r) => !r.provider.builtin && !this.health.get(r.provider.id));
      if (unchecked.length) {
        await Promise.all(unchecked.map((r) => this.health.check(r.provider.id).catch(() => undefined)));
        route = this.router.route({ capability: req.capability, detection: (id) => this.health.get(id), prefer, failures: scope.taskId ? this.failures.get(scope.taskId) : undefined });
      }
    }
    if (!route.ok && route.code === 'NOT_INSTALLED' && scope.cwd) {
      // Not on PATH, but the repository may carry it (node_modules/.bin/wrangler as a devDependency).
      const local = new Map<string, ToolDetection>();
      for (const r of this.registry.offering(req.capability)) {
        if (r.provider.builtin) continue;
        const found = await this.detectIn(r.provider, scope.cwd);
        if (found?.installed) local.set(r.provider.id, found);
      }
      if (local.size) route = this.router.route({ capability: req.capability, detection: (id) => local.get(id) ?? this.health.get(id), prefer, failures: scope.taskId ? this.failures.get(scope.taskId) : undefined });
    }
    if (!route.ok) return refuse('failed', route.code === 'UNKNOWN_CAPABILITY' ? 'UNKNOWN_CAPABILITY' : 'NOT_INSTALLED', route.reason, 'deny');
    const { provider, operation } = route.route;
    base.providerId = provider.id;
    base.routeReason = route.reason;

    // 2. Validate the input against the capability's schema.
    const parsed = operation.input.safeParse(rawInput ?? {});
    if (!parsed.success) return refuse('failed', 'INVALID_INPUT', `Invalid input for ${req.capability}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`, 'deny');
    const input = parsed.data;

    // 3. Classify this concrete call. It is judged with the task's own folders written relative to them: an isolated
    // task's worktree lives in the data folder, and its own path is not the Control Center's files. Only the judging
    // sees this form; the call runs with its input as given.
    const judged = relativizeOwnRoots(input, ownRoots(scope));
    const processHost = this.d.processes.host(scope.taskId, scope.stageId);
    const classified = operation.classify?.(judged, { cwd: scope.cwd, isTaskOwnedPid: (pid) => processHost.isTaskOwnedPid(pid), releaseBranches: this.releaseBranchesOf(scope) });
    // Fails closed: a call is a read only when its operation says so and its classification does not say otherwise.
    let risk: ToolRisk = { ...this.baseRisk(operation.level, operation.title), ...classified, writes: classified?.writes ?? !operation.readOnly };

    // An agent never reaches the Control Center itself — its token, keys, data folder or API — through
    // any tool: it runs as the operator's user, so that would let it act as the operator (audit F-02).
    // Every URL in the input is read the way the tool's own `new URL()` will read it, so `127.1:4317`,
    // `2130706433:4317` and `[::ffff:127.0.0.1]:4317` are the listen address too (SEC-1).
    if (req.origin === 'agent' && inputReferencesSelf(judged)) {
      const self: ToolRisk = { ...risk, level: 5, risk: 'dangerous', reasons: ["Reaches the Control Center's own token, data folder or API"] };
      this.escalate(scope, req.capability, 'denied', self.reasons[0]!, 5);
      return refuse('denied', 'DENIED', `${self.reasons[0]}. Agents cannot do this; report it as an operator decision.`, 'deny', self);
    }

    // A design stage never reaches an outside MCP server, whatever its level or profile (see ToolScope.designSession).
    if (req.origin === 'agent' && scope.designSession && provider.id.startsWith('mcp:')) {
      this.escalate(scope, req.capability, 'denied', DESIGN_MCP_REFUSAL, risk.level);
      return refuse('denied', 'DENIED', DESIGN_MCP_REFUSAL, 'deny', risk);
    }

    // 3b. What the call sends off this machine (SEC-4): a stored credential outside its audience, or a known
    // secret (raw or encoded) or token in what the caller wrote. Refused for agents, asked of anyone else.
    const outbound = operation.outbound ? await this.outboundCheck(operation, input, scope) : null;
    const leak = outbound?.leak ?? null;
    if (outbound) {
      // Recorded again now that the check has taught the redactor every stored value; a string in which the check
      // still reads a secret once redacted (base64 wrapped over lines, hex bytes spaced) is recorded masked whole.
      const everywhere = outbound.secrets.map(({ hosts: _hosts, ...secret }) => secret);
      base.inputSummary = clipInput(req.input, (text) => scanOutbound({ target: 'the record', body: redact(text) }, everywhere).length > 0);
    }
    if (leak) risk = { ...risk, reasons: [...risk.reasons, leak.reason], effects: [...new Set([...risk.effects, 'credentials' as const])] };

    // 4. Policy.
    const inProfile = profileIncludes(PROFILES[scope.profile], req.capability) || scope.escalated.has(req.capability);
    let decision = decide({ risk, mode: scope.mode, autoApproveUpToLevel: scope.autoApproveUpToLevel, stageLevel: scope.stageLevel, inProfile, origin: req.origin, ...(leak ? { leak: leak.reason } : {}), ...(scope.readOnly ? { readOnly: { allowed: scope.readOnly.allow.has(req.capability) } } : {}) });
    // The operator approved this very send: the broker may hand the credential to this call's host.
    const approvedSend = Boolean(leak) && req.preApproved === true && req.origin !== 'agent' && decision.decision === 'approval';
    if (req.preApproved && decision.decision === 'approval') decision = { decision: 'allow', reason: `${decision.reason} — approved` };
    if (leak) this.leakEvent(scope, req.capability, leak, decision.decision);
    if (decision.decision === 'deny') {
      this.escalate(scope, req.capability, 'denied', decision.reason, risk.level);
      return refuse('denied', 'DENIED', decision.reason, 'deny', risk);
    }
    if (decision.decision === 'approval') {
      this.escalate(scope, req.capability, 'approval', decision.reason, risk.level);
      return refuse('needs_approval', 'NEEDS_APPROVAL', `${decision.reason}. Confirm it to run.`, 'approval', risk);
    }
    if (decision.decision === 'escalate') {
      scope.escalated.add(req.capability);
      this.escalate(scope, req.capability, 'enabled', decision.reason, risk.level);
    }

    // 4b. Spend gate: a paid call (image or video generation) runs only with paid generation on and an
    // estimate that fits the task's media budget and every media budget that stops runs. Fails closed.
    let reservation: string | null = null;
    if (operation.estimateCost) {
      let reserved: { ok: true; id: string } | { ok: false; reason: string };
      try {
        const estimate = operation.estimateCost(input, this.d.spend?.prices() ?? {});
        reserved = this.d.spend ? this.d.spend.reserve({ taskId: scope.taskId, stageId: scope.stageId, executionId: base.id, capability: req.capability, provider: provider.id, origin: req.origin, estimate }) : { ok: false, reason: 'No spend gate is configured, so paid calls do not run.' };
      } catch (error) {
        reserved = { ok: false, reason: `The cost of this call could not be estimated (${redact((error as Error).message).slice(0, 200)}), so it is not run.` };
      }
      if (!reserved.ok) {
        this.escalate(scope, req.capability, 'denied', reserved.reason, risk.level);
        return refuse('denied', 'DENIED', reserved.reason, 'deny', risk);
      }
      reservation = reserved.id;
    }

    // 5. Checkpoint before high-impact work in a task.
    if (scope.taskId && (risk.level >= 3 || (risk.effects.includes('database') && risk.level >= 2))) {
      await this.checkpointsFor(scope.taskId)
        ?.create(`Before ${req.capability}`)
        .catch(() => null);
    }

    // 6. Run with brokered credentials, a timeout and cancellation.
    const execution: ToolExecution = { ...base, status: 'running', decision: decision.decision, permissionLevel: risk.level, risk: risk.risk, effects: risk.effects, summary: null, errorCode: null };
    this.record(execution);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutMs = req.timeoutMs ?? (operation.longRunning ? 15 * 60_000 : 30 * 60_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let result: OperationResult;
    try {
      let credentialEnv: Record<string, string> = {};
      let missingCredential: string | null = null;
      if (operation.credentials?.length) {
        if (scope.readOnly) {
          // Pinned or nothing: a read-only session never falls back to another credential or a login.
          const pinned = await this.d.credentials.envForPinned(operation.credentials, scope.readOnly.credentials);
          credentialEnv = pinned.env;
          missingCredential = pinned.missing[0] ?? null;
        } else {
          credentialEnv = await this.d.credentials.envFor(operation.credentials, scope.repositoryId);
        }
      }
      // In a task workspace, a Git process started by any tool stops searching for a repository at the workspaces folder.
      const ceiling = req.scope.repositories?.length ? { GIT_CEILING_DIRECTORIES: path.dirname(req.scope.roots[0]!) } : {};
      const readOnlyEnv = scope.readOnly ? { ...scope.readOnly.env, ACC_READ_ONLY: '1' } : {};
      const ctx = this.context(scope, { executionId: execution.id, env: { ...this.env(), ...ceiling, ...credentialEnv, ...readOnlyEnv }, signal: controller.signal, timeoutMs, onLine: req.onLine, deploysReserved: SECRET_DEPLOYS.has(req.capability) && risk.level >= 5, approvedSend });
      result = missingCredential
        ? { ok: false, summary: `No read-only ${missingCredential} key is set up for this conversation (Settings → Ask).`, error: { code: 'AUTH_REQUIRED', message: `No read-only ${missingCredential} key is set up (Settings → Ask).` } }
        : await Promise.race([
            operation.run(input, ctx),
            new Promise<OperationResult>((resolve) => controller.signal.addEventListener('abort', () => resolve({ ok: false, summary: req.signal?.aborted ? 'Stopped' : `Timed out after ${Math.round(timeoutMs / 1000)}s`, error: { code: req.signal?.aborted ? 'CANCELLED' : 'TIMEOUT', message: 'aborted' } }), { once: true })),
          ]);
    } catch (error) {
      result = { ok: false, summary: redact((error as Error).message).slice(0, 500), error: { code: 'FAILED', message: redact((error as Error).message).slice(0, 500) } };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
    result = { ...result, summary: redact(result.summary), stdout: result.stdout ? redact(result.stdout) : undefined, stderr: result.stderr ? redact(result.stderr) : undefined };
    if (reservation) this.d.spend?.settle(reservation, result);
    if (scope.readOnly?.maskPersonal) result = maskResult(result);

    // 7. Record, remember provider failures for routing, and surface notable calls.
    const done = this.finish(execution, result, started);
    if (scope.taskId) {
      const perTask = this.failures.get(scope.taskId) ?? new Map<string, number>();
      if (!result.ok && result.error?.code !== 'INVALID_INPUT') perTask.set(provider.id, (perTask.get(provider.id) ?? 0) + 1);
      this.failures.set(scope.taskId, perTask);
      if (risk.level >= 3 || operation.longRunning || (!result.ok && risk.level >= 2) || result.evidence?.length) {
        this.events(scope.taskId, 'TOOL_CALL', `${req.capability}: ${result.summary.slice(0, 200)}`, { executionId: done.id, capability: req.capability, ok: result.ok }, scope.stageId);
      }
    }
    return { execution: done, result, decision: decision.decision };
  }

  /**
   * Forget what was detected in a folder: its dependencies were just
   * installed (a worktree installed beside read-only stages), so a tool found
   * missing a moment ago may be there now.
   */
  forgetFolder(cwd: string): void {
    for (const key of [...this.folderDetections.keys()]) if (key.endsWith(`|${cwd}`)) this.folderDetections.delete(key);
  }

  /**
   * A provider detected in one folder rather than on PATH alone: the global
   * health check runs without a folder, so it cannot see project-local
   * binaries. Cached briefly per provider and folder.
   */
  private async detectIn(provider: ToolProvider, cwd: string): Promise<ToolDetection | undefined> {
    const key = `${provider.id}|${cwd}`;
    const cached = this.folderDetections.get(key);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.detection;
    try {
      const detection = await provider.detect({ env: this.env(), cwd, shell: (k) => this.shell(k), tempDir: this.tempDir() });
      if (this.folderDetections.size >= 200) this.folderDetections.clear();
      this.folderDetections.set(key, { at: Date.now(), detection });
      return detection;
    } catch {
      return undefined;
    }
  }

  /**
   * The outbound check (SEC-4) of one call, before it runs: a credential it
   * attaches by name to a host outside that credential's audience, and the
   * secrets the Control Center knows — stored credentials (each exempt on the
   * hosts it may be sent to, where this repository may use it), its own token,
   * sensitive environment values — raw or encoded, plus well-known token
   * formats, in the URL, headers or body the caller wrote (and a multipart
   * file's content). `leak` is null when clean; `secrets` are the values it
   * looked for. Fails closed: a request that cannot be checked — the credential
   * key not loading included — is reported as a leak.
   */
  private async outboundCheck(operation: Pick<ToolOperation, 'outbound'>, input: unknown, scope: ToolScope): Promise<{ leak: OutboundLeak | null; secrets: OutboundSecret[] }> {
    let secrets: OutboundSecret[] = [];
    try {
      const requests = await operation.outbound!(input, { cwd: scope.cwd, roots: scope.roots });
      if (!requests.length) return { leak: null, secrets };
      const stored = await this.d.credentials.outboundSecrets(scope.repositoryId);
      const token = this.d.localToken ?? null;
      const labelled = new Set([...stored.map((s) => s.value), ...(token ? [token] : [])]);
      secrets = [
        ...stored,
        ...(token ? [{ label: 'the Control Center token', kind: 'control-center-token', value: token }] : []),
        ...knownSecretValues()
          .filter((v) => !labelled.has(v))
          .map((value) => ({ label: 'a secret the Control Center keeps', kind: 'secret', value })),
      ];
      // Its host named as the findings name it: never a host whose own name carries a secret.
      const audience = requests.flatMap((r) => {
        const outside = r.credential && r.url ? this.d.credentials.outsideAudience(r.credential, scope.repositoryId, r.url) : null;
        return outside ? [{ ...outside, host: namedHost(r, secrets) }] : [];
      });
      const findings = requests.flatMap((r) => scanOutbound(r, secrets));
      if (!audience.length && !findings.length) return { leak: null, secrets };
      const lines = [
        ...audience.map((a) => `Sends ${a.kind} credential "${a.name}" to ${a.host}, which is not among the hosts it may be sent to (Tools → Credentials)`),
        ...(findings.length ? [describeFindings(findings)] : []),
      ];
      return {
        leak: { reason: redact(lines.join('; ')).slice(0, 600), audience: audience.map((a) => ({ ...a, host: redact(a.host).slice(0, 200) })), findings: findings.map((f) => ({ ...f, host: redact(f.host).slice(0, 200) })) },
        secrets,
      };
    } catch (error) {
      return { leak: { reason: `The request could not be checked for secrets (${redact((error as Error).message).slice(0, 200)})`, audience: [], findings: [] }, secrets };
    }
  }

  /** The TOOL_CALL event of a call the outbound check stopped or an operator let through: kinds, names and hosts only. */
  private leakEvent(scope: ToolScope, capability: string, leak: OutboundLeak, decision: PolicyDecision['decision']): void {
    if (!scope.taskId) return;
    const verb = decision === 'deny' ? 'refused' : decision === 'approval' ? 'needs approval' : 'sent with approval';
    this.events(
      scope.taskId,
      'TOOL_CALL',
      `${capability} ${verb}: ${leak.reason}`.slice(0, 700),
      {
        capability,
        ok: decision === 'allow',
        decision,
        outbound: [
          ...leak.audience.map((a) => ({ kind: a.kind, name: a.name, host: a.host, reason: 'outside audience' })),
          ...leak.findings.map((f) => ({ kind: f.kind, name: f.label, host: f.host, where: f.where, form: f.form })),
        ],
      },
      scope.stageId,
    );
  }

  private context(scope: ToolScope, run: { executionId: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number; onLine?: OperationContext['onLine']; deploysReserved: boolean; approvedSend?: boolean }): OperationContext {
    const artifacts: ArtifactSink | undefined = scope.taskId
      ? {
          write: async (a) => {
            const rec = await this.d.artifacts.write(scope.taskId!, { name: a.name, type: a.type, content: a.content, stageId: scope.stageId, redactContent: typeof a.content === 'string' });
            return { id: rec.id, name: rec.name };
          },
        }
      : undefined;
    return {
      executionId: run.executionId,
      taskId: scope.taskId,
      cwd: scope.cwd,
      roots: scope.roots,
      baseline: scope.baseline ?? null,
      env: run.env,
      signal: run.signal,
      timeoutMs: run.timeoutMs,
      onLine: run.onLine,
      tempDir: this.tempDir(),
      stateDir: this.stateDir(),
      shell: (k) => this.shell(k),
      detection: (id) => this.health.get(id),
      processes: this.d.processes.host(scope.taskId, scope.stageId),
      terminals: this.d.settings.get().execution.terminals ? this.d.terminals.host(scope.taskId, scope.stageLevel, this.releaseBranchesOf(scope)) : undefined,
      checkpoints: scope.taskId ? this.checkpointsFor(scope.taskId) : undefined,
      artifacts,
      prices: this.d.spend?.prices(),
      credentials: {
        // Only a production secret deploy, which always waits for the operator's typed approval, may read a credential kept for the orchestrator (LEAD_TIME_PLAN §6).
        // Sent as a header to `targetUrl`: only within its audience, or as the operator just approved (SEC-4).
        value: (name, opts) =>
          this.d.credentials.value(name, scope.repositoryId, {
            ...(run.deploysReserved ? { reserved: 'deploy' as const } : {}),
            ...(opts?.kind ? { kind: opts.kind } : {}),
            ...(opts?.targetUrl !== undefined ? { targetUrl: opts.targetUrl, approvedSend: run.approvedSend === true } : {}),
          }),
        envFor: (kinds) => this.d.credentials.envFor(kinds, scope.repositoryId),
        // A secret generated in a task belongs to that task's repository only; the operator may widen it later.
        generate: async (input) => {
          // Across repositories a secret must belong to one of them: name its folder.
          if (scope.repositories?.length && !scope.repositoryId) throw new Error('This task works in several repositories: set cwd to the folder of the repository the secret belongs to');
          const r = await this.d.credentials.generate({ ...input, repositoryIds: scope.repositoryId ? [scope.repositoryId] : [], taskId: scope.taskId });
          // With a MyVault delivery box set up, the new secret is saved for MyVault right away.
          if (this.d.deposits?.eligible(r.credential.id)) await this.d.deposits.ensureDeposited(r.credential.id, 15_000);
          const c = this.d.credentials.get(r.credential.id) ?? r.credential;
          return { created: r.created, credential: { id: c.id, name: c.name, kind: c.kind, envVar: c.envVar, fingerprint: c.fingerprint, repositoryIds: c.repositoryIds }, vaultSync: c.vault?.state ?? null };
        },
        deployGate: async (name, target) => {
          // A secret on its way to the delivery box is waited for, not refused a moment too early —
          // and only one this repository may use, so no other task can trigger its delivery.
          const record = this.d.toolStore.credential(name);
          const view = record ? this.d.credentials.get(record.id) : null;
          const inScope = view !== null && (view.repositoryIds === null || (scope.repositoryId !== null && view.repositoryIds.includes(scope.repositoryId)));
          if (record && inScope && this.d.deposits?.eligible(record.id)) await this.d.deposits.ensureDeposited(record.id);
          const blocked = this.d.credentials.deployGate(name, scope.repositoryId, { taskId: scope.taskId, target });
          if (!blocked || !record) return blocked;
          // Name the box this secret would go to, if its last attempt failed.
          const origin = this.d.credentials.get(record.id)?.vault?.origin ?? null;
          const box = this.d.deposits?.summary().find((t) => t.lastError && (origin === null || t.origin === origin));
          return box ? `${blocked} MyVault’s delivery box: ${box.lastError}` : blocked;
        },
      },
      privileged: this.privileged,
      protectedPaths: scope.protectedPaths,
    };
  }

  // ===========================================================================
  // Sessions (agents over MCP, operators from their own MCP client)
  // ===========================================================================

  openSession(scope: Omit<ToolScope, 'sessionId' | 'escalated'>, kind: 'agent' | 'operator', ttlMs = 8 * 3600_000, opts: { guardOnly?: boolean } = {}): ToolSession {
    const id = newId();
    const session: ToolSession = { id, token: randomBytes(32).toString('base64url'), scope: { ...scope, sessionId: id, escalated: new Set() }, kind, createdAt: now(), expiresAt: Date.now() + ttlMs, ...(opts.guardOnly ? { guardOnly: true } : {}) };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * The Control Center's judgement of a command an agent is about to run in
   * its CLI's own shell (SEC-3), asked by the run's command hook before each
   * one: the classification and policy `shell.*` gets, at the session's level,
   * origin `agent`, with that level counted as approved (the stage passed its
   * gate to be running). A native command cannot wait for an approval, so anything
   * `decide()` does not allow outright is refused, and so is a command that
   * names the Control Center itself (`referencesSelf`), Claude Code's settings
   * files, or — to do more than read — the hook's own script or folder
   * (`namesShellGuard`), through which the hook could be switched off. Its learned
   * plugins may be read (`excuseReadOnlyFolders`). Only refusals are recorded,
   * as `native.bash` rows in tool_executions. File reads: `precheckFile`.
   */
  precheck(session: ToolSession, command: string): NativeDecision {
    const refuse = (reason: string, risk: ToolRisk) => this.refuseNative(session, 'native.bash', { command }, reason, risk);
    const { scope } = session;
    if (NAMES_CLAUDE_SETTINGS.test(command)) {
      const reason = "Names Claude Code's settings files, through which the Control Center's checks could be switched off";
      return refuse(`${reason}. Agents cannot do this; report it as an operator decision.`, dangerous(reason, 'persistence'));
    }
    // The hook that asks this: changed, replaced or gone, it would let every later command through. Reading it is harmless.
    if (this.d.shellGuardPath && namesShellGuard(command, this.d.shellGuardPath) && !classifyCommand(command).readOnly) {
      const reason = "Changes the Control Center's check of shell commands, which would switch it off";
      return refuse(`${reason}. Agents cannot do this; report it as an operator decision.`, dangerous(reason, 'persistence'));
    }
    // Judged with the task's own folders written relative to them, as `invoke` judges a tool call: a worktree the
    // start could not move out of the data folder is the task's own, not the Control Center's files.
    const judged = relativizeOwnRoots(command, ownRoots(scope));
    // The learned plugins may be read; a command that does more than read them is judged as written.
    const excused = excuseReadOnlyFolders(judged, [learnedPluginsRoot(this.d.dataDir)]);
    const text = excused !== judged && classifyCommand(excused).readOnly ? excused : judged;
    if (referencesSelf(text)) {
      const reason = "Reaches the Control Center's own token, data folder or API";
      return refuse(`${reason}. Agents cannot do this; report it as an operator decision.`, dangerous(reason, 'credentials'));
    }
    const processHost = this.d.processes.host(scope.taskId, scope.stageId);
    const risk: ToolRisk = { ...this.baseRisk(2, 'Runs a native shell command'), ...classifyScript(text, [], { cwd: scope.cwd, isTaskOwnedPid: (pid) => processHost.isTaskOwnedPid(pid), releaseBranches: this.releaseBranchesOf(scope) }) };
    // The stage is running, so it passed its approval gate: its own level runs, as its native shell always did there.
    const decision = decide({ risk, mode: scope.mode, autoApproveUpToLevel: scope.autoApproveUpToLevel, stageLevel: scope.stageLevel, inProfile: true, origin: 'agent', approvedLevel: scope.stageLevel });
    if (decision.decision === 'allow') return { decision: 'allow' };
    const way = session.guardOnly ? 'report it as an operator decision' : `use the Control Center's shell tool (shell.run on the "acc" server), which applies the same policy, or report it as an operator decision`;
    return refuse(`${decision.reason.replace(/\.$/, '')}. A native shell command cannot wait for an approval: ${way}.`, risk);
  }

  /**
   * The same hook's judgement of a native file read (SEC-3): Claude Code's
   * `Read`, `Grep` or `Glob`, judged by the paths it reads (`NATIVE_FILE_PATHS`)
   * — as given, with `~` and Git Bash's `/c/…` spelled out, resolved against
   * the run's folder and the CLI's (`cwd`, which the hook reports; it only ever
   * refuses more), and through links. Refused: a path that names the Control
   * Center itself (`referencesSelf`: its data folder, token and key files,
   * address), and a search whose folder holds the data folder (it would read
   * every file in it). The learned plugins and this task's own attachments,
   * which live in the data folder, may be read (`excuseReadOnlyFolders`); the
   * worktree and every other path are allowed. Only refusals are recorded, as
   * `native.read`, `native.grep` or `native.glob` rows in tool_executions.
   */
  precheckFile(session: ToolSession, tool: GuardedFileTool, input: Record<string, unknown>, cwd: string | null = null): NativeDecision {
    const { scope } = session;
    const given = Object.fromEntries(NATIVE_FILE_PATHS[tool].flatMap((field) => (typeof input[field] === 'string' && input[field] ? [[field, input[field] as string]] : [])));
    const refuse = (reason: string) => this.refuseNative(session, `native.${tool.toLowerCase()}`, given, `${reason}. Agents cannot do this; report it as an operator decision.`, dangerous(reason, 'credentials'));
    const bases = [...new Set([scope.cwd, ...(cwd && path.isAbsolute(cwd) ? [cwd] : [])])];
    const spellings = (value: string): string[] => {
      const out = [value];
      if (/^~(?=[\\/]|$)/.test(value)) out.push(path.join(os.homedir(), value.slice(1)));
      if (process.platform === 'win32' && /^\/[A-Za-z](?=\/|$)/.test(value)) out.push(`${value[1]!.toUpperCase()}:${value.slice(2) || '\\'}`);
      return out;
    };
    const absolute = (value: string, from: readonly string[]) => spellings(value).flatMap((s) => from.map((base) => path.resolve(base, s)));
    // Grep and Glob search a folder — their `path`, else the CLI's — and their glob or pattern is read inside it.
    const roots = tool === 'Read' ? [] : given.path ? absolute(given.path, bases) : bases;
    const candidates = new Set<string>();
    const add = (p: string) => {
      candidates.add(p);
      if (path.isAbsolute(p)) candidates.add(realish(p));
    };
    for (const [field, value] of Object.entries(given)) for (const p of [...spellings(value), ...absolute(value, field === 'glob' || field === 'pattern' ? roots : bases)]) add(p);
    for (const root of roots) add(root);
    const readable = [learnedPluginsRoot(this.d.dataDir), ...(scope.taskId ? [path.join(this.d.dataDir, 'tasks', scope.taskId, 'attachments')] : [])];
    const own = ownRoots(scope);
    if ([...candidates].some((p) => referencesSelf(excuseReadOnlyFolders(relativizeOwnRoots(p, own), readable)))) return refuse("Reads the Control Center's own data folder, token or key files");
    const data = path.resolve(this.d.dataDir);
    if (roots.some((root) => isInside(root, data) || isInside(realish(root), realish(data)))) return refuse("Searches a folder that holds the Control Center's own data folder");
    return { decision: 'allow' };
  }

  /** Record a refused native call (the precheck's only rows) and answer the hook with the reason. */
  private refuseNative(session: ToolSession, capability: string, input: unknown, reason: string, risk: ToolRisk): NativeDecision {
    const { scope } = session;
    const at = now();
    this.record({
      id: newId(),
      taskId: scope.taskId,
      stageId: scope.stageId,
      sessionId: scope.sessionId,
      capability,
      providerId: null,
      origin: 'agent',
      routeReason: null,
      inputSummary: clipInput(input),
      attempt: 1,
      recoveryOf: null,
      artifacts: [],
      filesChanged: [],
      networkTargets: [],
      evidence: [],
      startedAt: at,
      finishedAt: at,
      durationMs: 0,
      status: 'denied',
      decision: 'deny',
      permissionLevel: risk.level,
      risk: risk.risk,
      effects: risk.effects,
      summary: redact(reason).slice(0, 500),
      errorCode: 'DENIED',
    });
    return { decision: 'deny', reason };
  }

  closeSession(id: string): void {
    this.sessions.delete(id);
  }

  closeSessionsForTask(taskId: string): void {
    for (const [id, s] of this.sessions) if (s.scope.taskId === taskId) this.sessions.delete(id);
  }

  /** Constant-time lookup of a session by its token. */
  sessionByToken(token: string | null | undefined): ToolSession | null {
    if (!token) return null;
    for (const s of this.sessions.values()) {
      if (constantTimeEqual(s.token, token)) {
        if (Date.now() > s.expiresAt) {
          this.sessions.delete(s.id);
          return null;
        }
        return s;
      }
    }
    return null;
  }

  /** The tools an agent sees: its profile, within its level, installed here; native overlaps and MCP stay reachable by id. */
  sessionTools(session: ToolSession): Array<{ name: string; capability: string; title: string; description: string; inputSchema: Record<string, unknown>; level: number }> {
    const { scope } = session;
    const ceiling = policyCeiling(scope.mode, scope.autoApproveUpToLevel);
    const out: Array<{ name: string; capability: string; title: string; description: string; inputSchema: Record<string, unknown>; level: number }> = [];
    // The profile's speciality first, then lower levels: over the cap, what is left out is general Git,
    // GitHub and editor tools the agent already runs natively; everything stays callable through acc_call_capability.
    const profile = PROFILES[scope.profile];
    const ordered = [...this.registry.capabilities()].sort((a, b) => profileRank(profile, a.id) - profileRank(profile, b.id) || a.level - b.level || a.id.localeCompare(b.id));
    for (const cap of ordered) {
      if (scope.readOnly) {
        // A read-only session lists exactly its allow-list, whatever the levels.
        if (!scope.readOnly.allow.has(cap.id)) continue;
      } else {
        const listed = profileIncludes(PROFILES[scope.profile], cap.id) || scope.escalated.has(cap.id);
        if (!listed || cap.level > Math.min(scope.stageLevel, ceiling)) continue;
      }
      if (session.kind === 'agent' && NATIVE_OVERLAP.test(cap.id)) continue;
      const route = this.router.route({ capability: cap.id, detection: (id) => this.health.get(id) });
      if (scope.designSession && route.ok && route.route.provider.id.startsWith('mcp:')) continue;
      // Providers never checked yet count as available: the first call detects them.
      const offering = this.registry.offering(cap.id).filter((r) => !r.provider.platforms || r.provider.platforms.includes(process.platform));
      const unchecked = !route.ok && route.code === 'NOT_INSTALLED' && offering.some((r) => !this.health.get(r.provider.id));
      if (!route.ok && !unchecked) continue;
      const operation = route.ok ? route.route.operation : offering[0]!.operation;
      out.push({ name: cap.id.replace(/\./g, '__'), capability: cap.id, title: cap.title, description: cap.description, inputSchema: operation.inputJsonSchema ?? jsonSchemaOf(operation.input), level: cap.level });
      if (out.length >= MAX_LISTED) break;
    }
    return out;
  }

  /** Search every capability and say whether this session could run it. */
  find(session: ToolSession, query: string): string {
    const { scope } = session;
    const ceiling = policyCeiling(scope.mode, scope.autoApproveUpToLevel);
    const hits = this.registry.search(query, scope.readOnly ? 40 : 12).filter((c) => !scope.readOnly || scope.readOnly.allow.has(c.id)).slice(0, 12);
    if (!hits.length) return `No capability matches "${query}"${scope.readOnly ? ' in this read-only conversation' : ''}.`;
    return hits
      .map((c) => {
        const route = this.router.route({ capability: c.id, detection: (id) => this.health.get(id) });
        const status = scope.readOnly
          ? route.ok || this.registry.offering(c.id).some((r) => !this.health.get(r.provider.id))
            ? 'available — call it with acc_call_capability'
            : `unavailable (${route.ok ? '' : route.reason})`
          : !route.ok
            ? `unavailable (${route.reason})`
            : scope.designSession && route.route.provider.id.startsWith('mcp:')
              ? 'refused in design stages (an outside tool declares no cost)'
              : c.level > scope.stageLevel
                ? `needs Level ${c.level}; this stage is Level ${scope.stageLevel}`
                : c.level > ceiling
                  ? 'needs approval'
                  : 'available — call it with acc_call_capability';
        // An outside server's tools take untyped input here: name their parameters so a call can be written.
        const schema = route.ok ? route.route.operation.inputJsonSchema : undefined;
        const params = schema ? ` Input: ${inputSummary(schema)}.` : '';
        return `- ${c.id} (Level ${c.level}): ${c.title}. ${c.description}${params} → ${status}`;
      })
      .join('\n');
  }

  /** Text for a model: summary, then bounded output. */
  static formatForModel(outcome: ToolCallOutcome): string {
    const r = outcome.result;
    const parts = [`${r.ok ? 'OK' : `FAILED${r.error ? ` (${r.error.code})` : ''}`}: ${r.summary}`];
    if (r.output !== undefined) {
      const text = JSON.stringify(r.output, null, 1);
      parts.push(text.length > 24_000 ? `${text.slice(0, 24_000)}\n[output truncated]` : text);
    }
    if (r.stdout) parts.push(`stdout:\n${r.stdout.slice(-16_000)}`);
    if (r.stderr) parts.push(`stderr:\n${r.stderr.slice(-6000)}`);
    if (r.evidence?.length) parts.push(`evidence:\n${r.evidence.join('\n')}`);
    if (r.artifacts?.length) parts.push(`artifacts: ${r.artifacts.map((a) => a.name).join(', ')}`);
    return parts.join('\n\n');
  }
}

/**
 * Personal data out of a result (docs/systems/ask.md): the model and the
 * record both see the masked form. A result that cannot be masked is dropped.
 */
function maskResult(result: OperationResult): OperationResult {
  try {
    return {
      ...result,
      summary: maskPersonalText(result.summary),
      ...(result.output !== undefined ? { output: maskPersonalData(result.output) } : {}),
      ...(result.stdout ? { stdout: maskPersonalText(result.stdout) } : {}),
      ...(result.stderr ? { stderr: maskPersonalText(result.stderr) } : {}),
      ...(result.evidence ? { evidence: result.evidence.map(maskPersonalText) } : {}),
    };
  } catch {
    return { ok: false, summary: 'The result could not be checked for personal data, so it was not shown.', error: { code: 'FAILED', message: 'Personal-data masking failed' } };
  }
}
