import path from 'node:path';
import { SimulatedAgentAdapter, type AgentAdapter } from '@acc/agent-sdk';
import { ClaudeCodeAdapter } from '@acc/agent-claude';
import { CodexAdapter } from '@acc/agent-codex';
import { Bus } from './bus.js';
import { Chairman } from './chairman/chairman.js';
import { ChairmanChat } from './chairman/chat.js';
import { Watchdog } from './chairman/watchdog.js';
import type { OrchestratorConfig } from './config.js';
import { migrate, openDatabase, type Db } from './db/database.js';
import { ContextBuilder } from './engine/context.js';
import { TaskEngine } from './engine/engine.js';
import { TaskViews } from './engine/views.js';
import { AgentRegistry } from './services/agents.js';
import { ArtifactService } from './services/artifacts.js';
import { PromptService } from './services/prompts.js';
import { RepositoryService } from './services/repositories.js';
import { RepositoryCoordinator } from './services/repository-coordinator.js';
import { SettingsService } from './services/settings.js';
import { WorkflowService } from './services/workflows.js';
import { SourceControlAssist } from './source-control/assist.js';
import { SourceControlService } from './source-control/service.js';
import { GitOperationStore } from './store/git-operations.js';
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
  coordinator: RepositoryCoordinator;
  gitOperations: GitOperationStore;
  sourceControl: SourceControlService;
  sourceControlAssist: SourceControlAssist;
  chairman: Chairman;
  chat: ChairmanChat;
  watchdog: Watchdog;
  startedAt: string;
  /** Restart recovery: engine reconciliation, then the Chairman's resume decisions. */
  recover(): Promise<{ interruptedTasks: string[] }>;
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

  const coordinator = new RepositoryCoordinator();
  const engine = new TaskEngine({ store, bus, views, agents, repositories, workflows, artifacts, context, settings, coordinator, baseEnv: options.baseEnv });
  const gitOperations = new GitOperationStore(db);
  const sourceControl = new SourceControlService({ store, operations: gitOperations, repositories, coordinator, bus });
  const sourceControlAssist = new SourceControlAssist({ sourceControl, repositories, agents, settings, engine, artifacts, store, views });
  const chairman = new Chairman({ store, bus, engine, views, agents, settings, artifacts, repositories, context });
  const chat = new ChairmanChat({ store, bus, views, agents, artifacts, chairman });
  const watchdog = new Watchdog(engine, store, views, settings, chairman);

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
    coordinator,
    gitOperations,
    sourceControl,
    sourceControlAssist,
    chairman,
    chat,
    watchdog,
    startedAt: new Date().toISOString(),
    async recover() {
      const result = engine.recover();
      await chairman.onStartup();
      chat.recoverPending();
      return result;
    },
    async close() {
      watchdog.stop();
      await engine.shutdown();
      await chat.idle();
      db.close();
    },
  };
}
