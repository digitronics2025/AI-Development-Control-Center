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
import { LearningService } from './learning/service.js';
import { SkillCatalog } from './services/skills.js';
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
import { VaultBridgeService } from './tools/vault-bridge.js';
import { TerminalService } from './tools/terminals.js';
import { UsageService } from './usage/service.js';
import { RemoteNodeService, type RemoteNodeDeps } from './remote/service.js';
import { ConnectedAppService } from './connected-apps/service.js';
import { ConnectedAppStore } from './connected-apps/store.js';

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
  /** MyVault bridge sessions (memory only) and trusted origins. */
  vaultBridge: VaultBridgeService;
  mcp: McpService;
  /** Skills the enabled agents would load, per repository (docs/systems/agents.md#skills). */
  skills: SkillCatalog;
  tooling: EngineTooling;
  privileged: PrivilegedHelper;
  usage: UsageService;
  /** This machine as a cloud execution node (docs/systems/remote-node.md); idle until paired. */
  remote: RemoteNodeService;
  /** The learning loop: reviews finished tasks and adopts improvements (docs/systems/learning.md). */
  learning: LearningService;
  /** Paired local apps such as Private Browser (docs/systems/connected-apps.md). */
  connectedApps: ConnectedAppService;
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
  options: { adapters?: AgentAdapter[]; baseEnv?: NodeJS.ProcessEnv; databaseFile?: string; remoteTimings?: RemoteNodeDeps['timings'] } = {},
): AppServices {
  const db = openDatabase(options.databaseFile ?? path.join(config.dataDir, 'acc.db'));
  migrate(db);
  const store = new Store(db);
  const bus = new Bus();
  const settings = new SettingsService(store, bus);
  const usage = new UsageService({ db, store, bus, dataDir: config.dataDir, simulated: config.simulatedAgents });
  const agents = new AgentRegistry(store, bus, settings, options.adapters ?? defaultAdapters(config), options.baseEnv ?? process.env, usage.recorder);
  usage.attachAdapters(() => agents.ids().map((id) => agents.adapter(id)));
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
  const vaultBridge = new VaultBridgeService(toolStore, credentials, { deposits: { bus } });
  const processes = new ProcessManager(toolStore, bus, executionEnv);
  const terminals = new TerminalService(toolStore, bus, { enabled: () => settings.get().execution.terminals, loopbackOnly: ['127.0.0.1', 'localhost', '::1'].includes(config.host), env: executionEnv });
  const tools = new ToolService({ toolStore, bus, settings, artifacts, processes, terminals, credentials, deposits: vaultBridge.deposits, dataDir: config.dataDir, baseEnv });
  const mcp = new McpService(toolStore, bus, tools, credentials);
  const privileged = new PrivilegedHelper(config.dataDir, path.join(config.resourcesDir, 'scripts', 'windows', 'privileged-helper.ps1'));
  const bridge = path.join(config.resourcesDir, 'apps', 'orchestrator', 'dist', 'acc-mcp.js');
  const skills = new SkillCatalog(agents);
  const tooling = new EngineTooling({ store, bus, tools, toolStore, processes, terminals, settings, artifacts, agents, mcp, skills, dataDir: config.dataDir, bridgePath: existsSync(bridge) ? bridge : null });
  context.toolSections = (task, def, repo) => tooling.promptSections(task, def, repo);
  const engine = new TaskEngine({ store, bus, views, agents, repositories, workflows, artifacts, context, settings, coordinator, tooling, baseEnv: options.baseEnv });
  const gitOperations = new GitOperationStore(db);
  const sourceControl = new SourceControlService({ store, operations: gitOperations, repositories, coordinator, bus });
  const repositoryAutomation = new RepositoryAutomation({ settings, repositories, sourceControl, store, bus, excludedFolders: [config.dataDir] });
  const sourceControlAssist = new SourceControlAssist({ sourceControl, repositories, agents, settings, engine, artifacts, store, views });
  const chairman = new Chairman({ store, bus, engine, views, agents, settings, artifacts, repositories, context, toolStore });
  const chat = new ChairmanChat({ store, bus, views, agents, artifacts, chairman });
  const watchdog = new Watchdog(engine, store, views, settings, chairman);
  const learning = new LearningService({ store, bus, settings, chairman, artifacts, toolStore, tools, skills, dataDir: config.dataDir, baseEnv });
  context.lessons = (task, def, stage) => learning.promptSection(task, def, stage);
  context.pluginDirs = (task) => learning.pluginDirs(task);
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
  const connectedApps = new ConnectedAppService({ apps: new ConnectedAppStore(db), store, bus, engine, views, artifacts, settings, workflows, identity: () => vaultBridge.identity() });
  const remote = new RemoteNodeService({ db, bus, config, store, views, settings, agents, repositories, tools, credentials, usage, terminals, artifacts, timings: options.remoteTimings });

  return {
    config,
    db,
    store,
    bus,
    settings,
    agents,
    skills,
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
    vaultBridge,
    mcp,
    tooling,
    privileged,
    usage,
    remote,
    learning,
    connectedApps,
    startedAt: new Date().toISOString(),
    async recover() {
      // Before anything runs: replay spooled usage and close attempts a stop interrupted.
      usage.recover();
      toolStore.interruptRunningExecutions();
      terminals.reconcileAfterRestart();
      await processes.reconcileAfterRestart().catch(() => undefined);
      const result = engine.recover();
      await chairman.onStartup();
      chat.recoverPending();
      // Reviews a restart interrupted resume, and completed tasks are reviewed from now on.
      learning.start();
      // Only once local state is settled: the cloud then receives the corrected picture.
      remote.start();
      return result;
    },
    async close() {
      await remote.stop();
      await learning.stop();
      vaultBridge.closeAll();
      watchdog.stop();
      await repositoryAutomation.stop();
      await engine.shutdown();
      await chat.idle();
      await processes.stopAll('orchestrator shutdown').catch(() => undefined);
      await terminals.shutdown().catch(() => undefined);
      await mcp.close().catch(() => undefined);
      usage.close();
      db.close();
    },
  };
}
