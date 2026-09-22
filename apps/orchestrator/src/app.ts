import path from 'node:path';
import { SimulatedAgentAdapter, type AgentAdapter } from '@acc/agent-sdk';
import { ClaudeCodeAdapter } from '@acc/agent-claude';
import { CodexAdapter } from '@acc/agent-codex';
import { Bus } from './bus.js';
import type { OrchestratorConfig } from './config.js';
import { migrate, openDatabase, type Db } from './db/database.js';
import { ContextBuilder } from './engine/context.js';
import { TaskEngine } from './engine/engine.js';
import { TaskViews } from './engine/views.js';
import { AgentRegistry } from './services/agents.js';
import { ArtifactService } from './services/artifacts.js';
import { PromptService } from './services/prompts.js';
import { RepositoryService } from './services/repositories.js';
import { SettingsService } from './services/settings.js';
import { WorkflowService } from './services/workflows.js';
import { Store } from './store/store.js';

export interface AppServices {
  config: OrchestratorConfig;
  db: Db;
  store: Store;
  bus: Bus;
  settings: SettingsService;
  agents: AgentRegistry;
  repositories: RepositoryService;
  workflows: WorkflowService;
  prompts: PromptService;
  artifacts: ArtifactService;
  views: TaskViews;
  engine: TaskEngine;
  startedAt: string;
  close(): Promise<void>;
}

export function defaultAdapters(config: Pick<OrchestratorConfig, 'simulatedAgents'>): AgentAdapter[] {
  if (config.simulatedAgents) {
    return [new SimulatedAgentAdapter('codex', 'Codex (simulated)'), new SimulatedAgentAdapter('claude', 'Claude Code (simulated)')];
  }
  return [new CodexAdapter(), new ClaudeCodeAdapter()];
}

/** Composition root: wires persistence, services and the engine. No I/O beyond the database. */
export function createServices(
  config: OrchestratorConfig,
  options: { adapters?: AgentAdapter[]; baseEnv?: NodeJS.ProcessEnv; databaseFile?: string } = {},
): AppServices {
  const db = openDatabase(options.databaseFile ?? path.join(config.dataDir, 'acc.db'));
  migrate(db);
  const store = new Store(db);
  const bus = new Bus();
  const settings = new SettingsService(store, bus);
  const agents = new AgentRegistry(store, bus, settings, options.adapters ?? defaultAdapters(config), options.baseEnv ?? process.env);
  const repositories = new RepositoryService(store, bus);
  const workflows = new WorkflowService(store, bus);
  const prompts = new PromptService(store, path.join(config.resourcesDir, 'prompts'));
  const artifacts = new ArtifactService(store, bus, config.dataDir);
  const views = new TaskViews(store, settings);
  const context = new ContextBuilder(store, artifacts, prompts);

  const loaded = workflows.loadBuiltins(path.join(config.resourcesDir, 'workflows'));
  if (loaded.errors.length) console.warn(`[workflows] ${loaded.errors.join('\n')}`);
  prompts.seed();

  const engine = new TaskEngine({ store, bus, views, agents, repositories, workflows, artifacts, context, settings, baseEnv: options.baseEnv });

  return {
    config,
    db,
    store,
    bus,
    settings,
    agents,
    repositories,
    workflows,
    prompts,
    artifacts,
    views,
    engine,
    startedAt: new Date().toISOString(),
    async close() {
      await engine.shutdown();
      db.close();
    },
  };
}
