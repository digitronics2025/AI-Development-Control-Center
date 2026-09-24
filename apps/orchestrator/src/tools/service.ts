import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveShell, type ShellInfo, type ShellKind } from '@acc/executor';
import { constantTimeEqual, redact, sanitizeEnv } from '@acc/security';
import type { CapabilityView, EventType, PermissionLevel, PolicyMode, ToolCallOrigin, ToolExecution, ToolExecutionStatus, ToolView } from '@acc/shared';
import {
  builtinProviders,
  decide,
  policyCeiling,
  PROFILES,
  profileIncludes,
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
  type ToolProvider,
  type ToolRisk,
} from '@acc/tools';
import { z } from 'zod';
import type { Bus } from '../bus.js';
import type { ArtifactService } from '../services/artifacts.js';
import type { SettingsService } from '../services/settings.js';
import { newId, now } from '../store/store.js';
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
}

/** Capabilities agents already have natively (their own Read/Edit/Bash and git): callable, but not listed, to keep prompts small. */
const NATIVE_OVERLAP = /^(?:fs\.|shell\.|process\.exec$|git\.(?:status|diff|log|show|branch_list|stage)$)/;
const MAX_LISTED = 60;

function clipInput(input: unknown): string {
  const shrink = (v: unknown): unknown => {
    if (typeof v === 'string') return v.length > 300 ? `[${v.length} characters]` : v;
    if (Array.isArray(v)) return v.slice(0, 20).map(shrink);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, shrink(x)]));
    return v;
  };
  const text = redact(JSON.stringify(shrink(input)) ?? '');
  return text.length > 800 ? `${text.slice(0, 799)}…` : text;
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
  dataDir: string;
  baseEnv: NodeJS.ProcessEnv;
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

  /** Late wiring: the engine's event publisher and the Chairman's checkpoints exist after this service. */
  attach(opts: { events?: ToolService['events']; checkpoints?: (taskId: string) => CheckpointHost | undefined; privileged?: OperationContext['privileged'] }): void {
    if (opts.events) this.events = opts.events;
    if (opts.checkpoints) this.checkpointsFor = opts.checkpoints;
    if (opts.privileged) this.privileged = opts.privileged;
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
    const { scope } = req;
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
    const parsed = operation.input.safeParse(req.input ?? {});
    if (!parsed.success) return refuse('failed', 'INVALID_INPUT', `Invalid input for ${req.capability}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`, 'deny');
    const input = parsed.data;

    // 3. Classify this concrete call.
    const processHost = this.d.processes.host(scope.taskId, scope.stageId);
    const risk: ToolRisk = { ...this.baseRisk(operation.level, operation.title), ...operation.classify?.(input, { cwd: scope.cwd, isTaskOwnedPid: (pid) => processHost.isTaskOwnedPid(pid) }) };

    // 4. Policy.
    const inProfile = profileIncludes(PROFILES[scope.profile], req.capability) || scope.escalated.has(req.capability);
    let decision = decide({ risk, mode: scope.mode, autoApproveUpToLevel: scope.autoApproveUpToLevel, stageLevel: scope.stageLevel, inProfile, origin: req.origin });
    if (req.preApproved && decision.decision === 'approval') decision = { decision: 'allow', reason: `${decision.reason} — approved` };
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
      const credentialEnv = operation.credentials?.length ? await this.d.credentials.envFor(operation.credentials, scope.repositoryId) : {};
      const ctx = this.context(scope, { executionId: execution.id, env: { ...this.env(), ...credentialEnv }, signal: controller.signal, timeoutMs, onLine: req.onLine });
      result = await Promise.race([
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

  private context(scope: ToolScope, run: { executionId: string; env: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number; onLine?: OperationContext['onLine'] }): OperationContext {
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
      env: run.env,
      signal: run.signal,
      timeoutMs: run.timeoutMs,
      onLine: run.onLine,
      tempDir: this.tempDir(),
      stateDir: this.stateDir(),
      shell: (k) => this.shell(k),
      detection: (id) => this.health.get(id),
      processes: this.d.processes.host(scope.taskId, scope.stageId),
      terminals: this.d.settings.get().execution.terminals ? this.d.terminals.host(scope.taskId, scope.stageLevel) : undefined,
      checkpoints: scope.taskId ? this.checkpointsFor(scope.taskId) : undefined,
      artifacts,
      credentials: {
        value: (name) => this.d.credentials.value(name, scope.repositoryId),
        envFor: (kinds) => this.d.credentials.envFor(kinds, scope.repositoryId),
        // A secret generated in a task belongs to that task's repository only; the operator may widen it later.
        generate: async (input) => {
          const r = await this.d.credentials.generate({ ...input, repositoryIds: scope.repositoryId ? [scope.repositoryId] : [], taskId: scope.taskId });
          const c = r.credential;
          return { created: r.created, credential: { id: c.id, name: c.name, kind: c.kind, envVar: c.envVar, fingerprint: c.fingerprint, repositoryIds: c.repositoryIds }, vaultSync: c.vault?.state ?? null };
        },
        deployGate: async (name, target) => this.d.credentials.deployGate(name, scope.repositoryId, { taskId: scope.taskId, target }),
      },
      privileged: this.privileged,
      protectedPaths: scope.protectedPaths,
    };
  }

  // ===========================================================================
  // Sessions (agents over MCP, operators from their own MCP client)
  // ===========================================================================

  openSession(scope: Omit<ToolScope, 'sessionId' | 'escalated'>, kind: 'agent' | 'operator', ttlMs = 8 * 3600_000): ToolSession {
    const id = newId();
    const session: ToolSession = { id, token: randomBytes(32).toString('base64url'), scope: { ...scope, sessionId: id, escalated: new Set() }, kind, createdAt: now(), expiresAt: Date.now() + ttlMs };
    this.sessions.set(id, session);
    return session;
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
    for (const cap of this.registry.capabilities()) {
      const listed = profileIncludes(PROFILES[scope.profile], cap.id) || scope.escalated.has(cap.id);
      if (!listed || cap.level > Math.min(scope.stageLevel, ceiling)) continue;
      if (session.kind === 'agent' && NATIVE_OVERLAP.test(cap.id)) continue;
      const route = this.router.route({ capability: cap.id, detection: (id) => this.health.get(id) });
      // Providers never checked yet count as available: the first call detects them.
      const offering = this.registry.offering(cap.id).filter((r) => !r.provider.platforms || r.provider.platforms.includes(process.platform));
      const unchecked = !route.ok && route.code === 'NOT_INSTALLED' && offering.some((r) => !this.health.get(r.provider.id));
      if (!route.ok && !unchecked) continue;
      const operation = route.ok ? route.route.operation : offering[0]!.operation;
      out.push({ name: cap.id.replace(/\./g, '__'), capability: cap.id, title: cap.title, description: cap.description, inputSchema: jsonSchemaOf(operation.input), level: cap.level });
      if (out.length >= MAX_LISTED) break;
    }
    return out;
  }

  /** Search every capability and say whether this session could run it. */
  find(session: ToolSession, query: string): string {
    const { scope } = session;
    const ceiling = policyCeiling(scope.mode, scope.autoApproveUpToLevel);
    const hits = this.registry.search(query, 12);
    if (!hits.length) return `No capability matches "${query}".`;
    return hits
      .map((c) => {
        const route = this.router.route({ capability: c.id, detection: (id) => this.health.get(id) });
        const status = !route.ok ? `unavailable (${route.reason})` : c.level > scope.stageLevel ? `needs Level ${c.level}; this stage is Level ${scope.stageLevel}` : c.level > ceiling ? 'needs approval' : 'available — call it with acc_call_capability';
        return `- ${c.id} (Level ${c.level}): ${c.title}. ${c.description} → ${status}`;
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
