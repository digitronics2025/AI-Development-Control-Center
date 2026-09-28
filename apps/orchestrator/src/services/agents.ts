import { AgentGuardError, cliCompat, type AgentAdapter, type AgentExecutionHandle, type AgentExecutionInput, type AgentRunAs, type AgentRuntimeOptions } from '@acc/agent-sdk';
import { PERMISSION_LEVEL_INFO, type AgentCapabilities, type AgentInfo, type AgentSettings, type ModelDescriptor, type PermissionLevel, type UsageBilling } from '@acc/shared';
import type { Bus } from '../bus.js';
import type { Store } from '../store/store.js';
import type { UsageAttribution } from '../usage/ledger.js';
import type { UsageMeter } from '../usage/recorder.js';
import type { SettingsService } from './settings.js';

const NO_CAPABILITIES: AgentCapabilities = {
  repositoryRead: false,
  repositoryWrite: false,
  commandExecution: false,
  images: false,
  interactive: false,
  nonInteractive: false,
  modelSelection: false,
  effortSelection: false,
  pluginDirs: false,
  // Empty until the first health check stores the adapter's declaration; the dashboard then names the provider by its key.
  providerLabel: '',
  maxPermissionLevel: 1,
};

export class AgentNotFoundError extends Error {}

/**
 * Registry of agent adapters plus their persisted configuration, last health
 * result and model catalog. Health checks run on start, on demand, and
 * before every launch (inside the adapter's subscription guard).
 */
export class AgentRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();
  private refreshing: Promise<void> | null = null;
  /** The Control Center's own data folder and port, denied in every run's native rules (SEC-3); set at start. */
  private controlCenter: AgentRuntimeOptions['controlCenter'];
  private isolation: Omit<AgentRunAs, 'account'> | null = null;

  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly settings: SettingsService,
    adapters: AgentAdapter[],
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
    private readonly meter: UsageMeter | null = null,
  ) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.id, adapter);
      this.store.ensureAgent(adapter.id, adapter.displayName);
    }
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  adapter(id: string): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new AgentNotFoundError(`Unknown agent "${id}"`);
    return adapter;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  /**
   * What the adapter declares it can do, read from the adapter itself (never a
   * stored copy), for decisions: the permission ceiling, plugin folders.
   */
  capabilities(id: string): Promise<AgentCapabilities> {
    return this.adapter(id).getCapabilities();
  }

  /** Who pays for a run of this agent, as far as its last health check knows. */
  private billing(id: string, adapter: AgentAdapter): UsageBilling {
    if (adapter.usageCapabilities.provider === 'simulated') return 'simulated';
    return this.store.getAgent(id)?.health?.billing ?? 'unknown';
  }

  /**
   * Start an agent run through the usage meter — the one capture boundary
   * every provider attempt passes (docs/systems/usage.md#capture). A budget
   * whose policy stops new runs refuses the launch; once the process starts,
   * exactly one usage event is recorded when it finishes. Telemetry never
   * changes the run's result. A run above the permission level the adapter
   * can enforce (`maxPermissionLevel`) is refused before anything starts.
   */
  async launch(agentId: string, input: AgentExecutionInput, attribution: UsageAttribution): Promise<AgentExecutionHandle> {
    const adapter = this.adapter(agentId);
    const { maxPermissionLevel } = await adapter.getCapabilities();
    // Written to fail closed: a ceiling the adapter did not declare refuses every run.
    if (!(input.permissionLevel <= maxPermissionLevel)) {
      const level = (n: PermissionLevel) => (PERMISSION_LEVEL_INFO[n] ? `Level ${n} (${PERMISSION_LEVEL_INFO[n].name})` : `Level ${String(n)}`);
      throw new AgentGuardError(
        PERMISSION_LEVEL_INFO[maxPermissionLevel]
          ? `${adapter.displayName} can run at most ${level(maxPermissionLevel)}, and this run needs ${level(input.permissionLevel)}. Reroute the stage to an agent that allows it, or lower the stage's level.`
          : `${adapter.displayName} declares no permission ceiling (maxPermissionLevel), so no run of it starts. Reroute the stage to another agent.`,
        'PERMISSION_DENIED',
      );
    }
    const info = { agentId, capabilities: adapter.usageCapabilities, model: input.model, attribution };
    const blocked = this.meter?.blockReason(info) ?? null;
    if (blocked) throw new AgentGuardError(blocked, 'PERMISSION_DENIED');
    const handle = await adapter.execute(input);
    const dispatch = this.meter?.dispatched({ ...info, executionId: input.executionId, billing: this.billing(agentId, adapter), effort: input.effort, prompt: input.prompt }) ?? null;
    const done = handle.done.then(
      (result) => {
        this.meter?.finished(dispatch, result);
        return result;
      },
      (error: unknown) => {
        this.meter?.aborted(dispatch, error);
        throw error;
      },
    );
    return { ...handle, done };
  }

  runtimeOptions(id: string): AgentRuntimeOptions {
    const record = this.store.getAgent(id);
    return {
      billingMode: this.settings.get().billingMode,
      baseEnv: this.baseEnv,
      executablePath: record?.settings.executablePath ?? null,
      loadUserConfig: record?.settings.loadUserConfig ?? true,
      ...(this.controlCenter ? { controlCenter: this.controlCenter } : {}),
    };
  }

  /** Teach every later launch where the Control Center's own secrets and API are (the port once the server listens). */
  setControlCenter(controlCenter: NonNullable<AgentRuntimeOptions['controlCenter']>): void {
    this.controlCenter = controlCenter;
  }

  /** Where the agent account's password record and the relay are (SEC-3, docs/systems/security.md#agent-os-boundary); set at start. */
  setIsolation(paths: Omit<AgentRunAs, 'account'>): void {
    this.isolation = paths;
  }

  /**
   * The Windows account a stage's run starts as, or undefined while agent
   * isolation is off (Settings → `agentIsolation`). With it on, the adapter
   * refuses a run it cannot start as that account — unknown paths included —
   * and never starts it as the operator instead.
   */
  stageRunAs(): AgentRunAs | undefined {
    const { agentIsolation } = this.settings.get();
    if (agentIsolation.mode !== 'account') return undefined;
    return { account: agentIsolation.account, credentialFile: this.isolation?.credentialFile ?? '', relay: this.isolation?.relay ?? '' };
  }

  list(): AgentInfo[] {
    const models = this.store.listModels();
    return this.store
      .listAgents()
      .filter((a) => this.adapters.has(a.id))
      .map((a) => {
        const adapter = this.adapters.get(a.id)!;
        const detection = a.detection ?? { found: false, executablePath: null, version: null, error: null };
        return {
          id: a.id,
          name: a.name,
          provider: adapter.usageCapabilities.provider,
          detection,
          // Simulated agents have no CLI whose version could drift.
          compat: detection.found && detection.version && adapter.usageCapabilities.provider !== 'simulated' ? cliCompat(a.id, detection.version) : null,
          health: a.settings.enabled
            ? (a.health ?? { state: 'unknown', message: 'Not checked yet', authMethod: null, billing: 'unknown', checkedAt: null })
            : { state: 'disabled', message: 'Disabled in settings', authMethod: null, billing: 'unknown', checkedAt: a.health?.checkedAt ?? null },
          // A copy stored before a capability existed lacks it: the default fills the gap until the next health check.
          capabilities: { ...NO_CAPABILITIES, ...a.capabilities },
          models: models.filter((m) => m.agentId === a.id),
          settings: a.settings,
          capacityBlock: a.settings.enabled ? (this.meter?.capacityBlock(a.id) ?? null) : null,
        };
      });
  }

  get(id: string): AgentInfo {
    const info = this.list().find((a) => a.id === id);
    if (!info) throw new AgentNotFoundError(`Unknown agent "${id}"`);
    return info;
  }

  isEnabled(id: string): boolean {
    return this.store.getAgent(id)?.settings.enabled ?? false;
  }

  /** Re-detect one or all agents. Concurrent callers share one refresh. */
  async refresh(id?: string): Promise<AgentInfo[]> {
    if (!id && this.refreshing) {
      await this.refreshing;
      return this.list();
    }
    const run = async () => {
      const ids = id ? [id] : this.ids();
      await Promise.all(ids.map((agentId) => this.refreshOne(agentId)));
    };
    const promise = run();
    if (!id) this.refreshing = promise.finally(() => (this.refreshing = null));
    await promise;
    const agents = this.list();
    this.bus.publish({ type: 'agents', agents });
    return agents;
  }

  private async refreshOne(id: string): Promise<void> {
    const adapter = this.adapter(id);
    (adapter as { invalidateHealth?: () => void }).invalidateHealth?.();
    const options = this.runtimeOptions(id);
    const [detection, health, capabilities, models] = await Promise.all([
      adapter.detect(options),
      adapter.healthCheck(options),
      adapter.getCapabilities(),
      adapter.listModels(options).catch(() => [] as ModelDescriptor[]),
    ]);
    this.store.updateAgentStatus(id, detection, health, capabilities);
    this.store.replaceProviderModels(id, models);
  }

  updateSettings(id: string, patch: Partial<AgentSettings>): AgentInfo {
    const record = this.store.getAgent(id);
    if (!record || !this.adapters.has(id)) throw new AgentNotFoundError(`Unknown agent "${id}"`);
    this.store.updateAgentSettings(id, { ...record.settings, ...patch });
    this.bus.publish({ type: 'agents', agents: this.list() });
    return this.get(id);
  }

  addModel(agentId: string, modelId: string, label?: string, efforts?: string[]): AgentInfo {
    if (!this.adapters.has(agentId)) throw new AgentNotFoundError(`Unknown agent "${agentId}"`);
    const existing = this.store.listModels(agentId).find((m) => m.modelId === modelId);
    const fallbackEfforts = existing?.efforts ?? this.store.listModels(agentId)[0]?.efforts ?? ['low', 'medium', 'high'];
    this.store.upsertUserModel({
      agentId,
      modelId,
      label: label ?? modelId,
      efforts: efforts ?? fallbackEfforts,
      defaultEffort: null,
      source: 'user',
      description: null,
    });
    this.bus.publish({ type: 'agents', agents: this.list() });
    return this.get(agentId);
  }

  removeModel(agentId: string, modelId: string): boolean {
    const removed = this.store.deleteUserModel(agentId, modelId);
    if (removed) this.bus.publish({ type: 'agents', agents: this.list() });
    return removed;
  }
}
