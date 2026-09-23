import { existsSync } from 'node:fs';
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
import { RepositoryAutomation } from './services/repository-automation.js';
import { RepositoryCoordinator } from './services/repository-coordinator.js';
import { SettingsService } from './services/settings.js';
import { WorkflowService } from './services/workflows.js';
import { SourceControlAssist } from './source-control/assist.js';
import { SourceControlService } from './source-control/service.js';
import { GitOperationStore } from './store/git-operations.js';
import { Store } from './store/store.js';
import { EngineTooling } from './engine/tooling.js';
import { CredentialBroker, fileKeyProvider } from './tools/credentials.js';
import { environmentProvider } from './tools/environment.js';
import { McpService } from './tools/mcp.js';
import { PrivilegedHelper } from './tools/privileged.js';
import { ProcessManager } from './tools/processes.js';
import { ToolService } from './tools/service.js';
import { ToolStore } from './tools/store.js';
import { TerminalService } from './tools/terminals.js';

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
  repositoryAutomation: RepositoryAutomation;
  chairman: Chairman;
  chat: ChairmanChat;
  watchdog: Watchdog;
  /** Universal tool layer (docs/plans/tool-layer-v2). */
  toolStore: ToolStore;
  tools: ToolService;
  processes: ProcessManager;
  terminals: TerminalService;
  credentials: CredentialBroker;
  mcp: McpService;
  tooling: EngineTooling;
  privileged: PrivilegedHelper;
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
  const repositories = new RepositoryService(store, bus, settings);
  const workflows = new WorkflowService(store, bus);
  const prompts = new PromptService(store, path.join(config.resourcesDir, 'prompts'));
  const artifacts = new ArtifactService(store, bus, config.dataDir);
  const views = new TaskViews(store, settings);
  const context = new ContextBuilder(store, artifacts, prompts);

  const loaded = workflows.loadBuiltins(path.join(config.resourcesDir, 'workflows'));
  if (loaded.errors.length) console.warn(`[workflows] ${loaded.errors.join('\n')}`);
  prompts.seed();

  const coordinator = new RepositoryCoordinator();
  const baseEnv = options.baseEnv ?? process.env;
  const executionEnv = () => ({ base: baseEnv, billing: settings.get().billingMode });
  const toolStore = new ToolStore(db);
  const credentials = new CredentialBroker(toolStore, bus, fileKeyProvider(config.dataDir));
  const processes = new ProcessManager(toolStore, bus, executionEnv);
  const terminals = new TerminalService(toolStore, bus, { enabled: () => settings.get().execution.terminals, loopbackOnly: ['127.0.0.1', 'localhost', '::1'].includes(config.host), env: executionEnv });
  const tools = new ToolService({ toolStore, bus, settings, artifacts, processes, terminals, credentials, dataDir: config.dataDir, baseEnv });
  const mcp = new McpService(toolStore, bus, tools, credentials);
  const privileged = new PrivilegedHelper(config.dataDir, path.join(config.resourcesDir, 'scripts', 'windows', 'privileged-helper.ps1'));
  const bridge = path.join(config.resourcesDir, 'apps', 'orchestrator', 'dist', 'acc-mcp.js');
  const tooling = new EngineTooling({ store, bus, tools, toolStore, processes, terminals, settings, artifacts, agents, mcp, dataDir: config.dataDir, bridgePath: existsSync(bridge) ? bridge : null });
  context.toolSections = (task, def, repo) => tooling.promptSections(task, def, repo);
  const engine = new TaskEngine({ store, bus, views, agents, repositories, workflows, artifacts, context, settings, coordinator, tooling, baseEnv: options.baseEnv });
  const gitOperations = new GitOperationStore(db);
  const sourceControl = new SourceControlService({ store, operations: gitOperations, repositories, coordinator, bus });
  const repositoryAutomation = new RepositoryAutomation({ settings, repositories, sourceControl, store, bus, excludedFolders: [config.dataDir] });
  const sourceControlAssist = new SourceControlAssist({ sourceControl, repositories, agents, settings, engine, artifacts, store, views });
  const chairman = new Chairman({ store, bus, engine, views, agents, settings, artifacts, repositories, context });
  const chat = new ChairmanChat({ store, bus, views, agents, artifacts, chairman });
  const watchdog = new Watchdog(engine, store, views, settings, chairman);
  tools.registerProvider(environmentProvider({ store, repositories, tooling }));
  tools.attach({
    events: (taskId, type, message, data, stageId) => engine.publisher.event(taskId, type, message, data ?? {}, stageId ?? null),
    privileged,
    checkpoints: (taskId) => ({
      create: async (label) => {
        const task = store.getTask(taskId);
        const cp = task ? await chairman.checkpoints.create(task, { label, reason: 'user', stageKey: task.currentStageKey }) : null;
        return cp ? { id: cp.id, seq: cp.seq, label: cp.label } : null;
      },
      list: () => chairman.store.listCheckpoints(taskId).map((c) => ({ id: c.id, seq: c.seq, label: c.label, type: c.type ?? 'git', createdAt: c.createdAt })),
      restore: async (id) => {
        const task = store.getTask(taskId);
        if (!task) throw new Error('Task not found');
        const { result } = await chairman.checkpoints.restore(task, id);
        return { restored: result.restored.length, removed: result.removed.length, skipped: result.skipped.length };
      },
    }),
  });
  mcp.restore();

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
    repositoryAutomation,
    chairman,
    chat,
    watchdog,
    toolStore,
    tools,
    processes,
    terminals,
    credentials,
    mcp,
    tooling,
    privileged,
    startedAt: new Date().toISOString(),
    async recover() {
      toolStore.interruptRunningExecutions();
      terminals.reconcileAfterRestart();
      await processes.reconcileAfterRestart().catch(() => undefined);
      const result = engine.recover();
      await chairman.onStartup();
      chat.recoverPending();
      return result;
    },
    async close() {
      watchdog.stop();
      await repositoryAutomation.stop();
      await engine.shutdown();
      await chat.idle();
      await processes.stopAll('orchestrator shutdown').catch(() => undefined);
      await terminals.shutdown().catch(() => undefined);
      await mcp.close().catch(() => undefined);
      db.close();
    },
  };
}
