import type { AgentAdapter, AgentRuntimeOptions } from '@acc/agent-sdk';
import type { AgentCapabilities, AgentInfo, AgentSettings, ModelDescriptor } from '@acc/shared';
import type { Bus } from '../bus.js';
import type { Store } from '../store/store.js';
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

  constructor(
    private readonly store: Store,
    private readonly bus: Bus,
    private readonly settings: SettingsService,
    adapters: AgentAdapter[],
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
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

  runtimeOptions(id: string): AgentRuntimeOptions {
    const record = this.store.getAgent(id);
    return {
      billingMode: this.settings.get().billingMode,
      baseEnv: this.baseEnv,
      executablePath: record?.settings.executablePath ?? null,
      loadUserConfig: record?.settings.loadUserConfig ?? true,
    };
  }

  list(): AgentInfo[] {
    const models = this.store.listModels();
    return this.store
      .listAgents()
      .filter((a) => this.adapters.has(a.id))
      .map((a) => ({
        id: a.id,
        name: a.name,
        detection: a.detection ?? { found: false, executablePath: null, version: null, error: null },
        health: a.settings.enabled
          ? (a.health ?? { state: 'unknown', message: 'Not checked yet', authMethod: null, billing: 'unknown', checkedAt: null })
          : { state: 'disabled', message: 'Disabled in settings', authMethod: null, billing: 'unknown', checkedAt: a.health?.checkedAt ?? null },
        capabilities: a.capabilities ?? NO_CAPABILITIES,
        models: models.filter((m) => m.agentId === a.id),
        settings: a.settings,
      }));
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
