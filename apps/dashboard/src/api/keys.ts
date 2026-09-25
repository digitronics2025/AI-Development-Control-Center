/** Query keys in one place so realtime sync and hooks never drift apart. */
export const keys = {
  health: ['health'] as const,
  overview: ['overview'] as const,
  tasksRoot: ['tasks'] as const,
  tasks: (filters: Record<string, string | undefined>) => ['tasks', filters] as const,
  task: (id: string) => ['task', id] as const,
  taskEvents: (id: string) => ['task', id, 'events'] as const,
  taskExecutions: (id: string) => ['task', id, 'executions'] as const,
  taskTests: (id: string) => ['task', id, 'tests'] as const,
  taskArtifacts: (id: string) => ['task', id, 'artifacts'] as const,
  taskChanges: (id: string) => ['task', id, 'changes'] as const,
  taskTime: (id: string) => ['task', id, 'time'] as const,
  taskDiff: (id: string, path: string | null, repositoryId: string | null = null) => ['task', id, 'diff', path ?? '*', repositoryId ?? ''] as const,
  taskDirectives: (id: string) => ['task', id, 'directives'] as const,
  taskApprovals: (id: string) => ['task', id, 'approvals'] as const,
  chairman: (id: string) => ['task', id, 'chairman'] as const,
  /** Ask conversations (local mode only); one prefix for the list and each conversation. */
  askRoot: ['ask'] as const,
  askThreads: ['ask', 'threads'] as const,
  askThread: (id: string) => ['ask', 'thread', id] as const,
  /** Which Ask data sources are set up; follows settings and credentials. */
  askSources: ['ask', 'sources'] as const,
  /** An answer being written (`ask.delta`): transient, never fetched, dropped when the answer is stored. */
  askDraft: (messageId: string) => ['ask', 'draft', messageId] as const,
  logs: (executionId: string) => ['logs', executionId] as const,
  artifactContent: (id: string) => ['artifact', id] as const,
  approvals: (status: 'pending' | 'all') => ['approvals', status] as const,
  agents: ['agents'] as const,
  /** Skills the agents would load in a repository (New Task slash picker). */
  skills: (repositoryId: string) => ['skills', repositoryId] as const,
  repositories: ['repositories'] as const,
  repository: (id: string) => ['repository', id] as const,
  repositoryAutomation: ['repository-automation'] as const,
  workflows: ['workflows'] as const,
  workflow: (id: string) => ['workflow', id] as const,
  settings: ['settings'] as const,
  /** Tool layer (docs/plans/tool-layer-v2). */
  tools: ['tools'] as const,
  capabilities: ['tools', 'capabilities'] as const,
  taskExecution: (id: string) => ['task', id, 'execution'] as const,
  processes: ['processes'] as const,
  terminals: ['terminals'] as const,
  mcpServers: ['mcp'] as const,
  credentials: ['credentials'] as const,
  /** Paired local apps such as Private Browser (local mode only); one prefix for status and task origins. */
  connectedAppsRoot: ['connected-apps'] as const,
  connectedApps: ['connected-apps', 'status'] as const,
  connectedAppOrigins: ['connected-apps', 'origins'] as const,
  prompts: ['prompts'] as const,
  /** Everything Source Control shows for one repository; one prefix so realtime invalidation reaches it all. */
  sourceControlRoot: (repositoryId: string) => ['source-control', repositoryId] as const,
  sourceControl: (repositoryId: string) => ['source-control', repositoryId, 'snapshot'] as const,
  sourceControlDiff: (repositoryId: string, path: string | null, mode: string) => ['source-control', repositoryId, 'diff', path ?? '', mode] as const,
  sourceControlHistory: (repositoryId: string) => ['source-control', repositoryId, 'history'] as const,
  sourceControlCommit: (repositoryId: string, sha: string) => ['source-control', repositoryId, 'commit', sha] as const,
  sourceControlCommitDiff: (repositoryId: string, sha: string, path: string | null) => ['source-control', repositoryId, 'commit', sha, 'diff', path ?? ''] as const,
  sourceControlOperations: (repositoryId: string) => ['source-control', repositoryId, 'operations'] as const,
  sourceControlReview: (repositoryId: string) => ['source-control', repositoryId, 'review'] as const,
  /** Everything Usage & Costs shows; one prefix so a recorded attempt refreshes it all. */
  usageRoot: ['usage'] as const,
  /** The learning loop (local mode only): overview and per-task reviews share one prefix. */
  learningRoot: ['learning'] as const,
  learningTask: (id: string) => ['learning', 'task', id] as const,
  /** This machine's link to the cloud control plane (local mode only). */
  remoteStatus: ['remote', 'status'] as const,
  /** Cloud mode: control-plane state (never cleared by a node switch). */
  cloudNodes: ['cloud', 'nodes'] as const,
  cloudCommands: ['cloud', 'commands'] as const,
  cloudPairingTokens: ['cloud', 'pairing-tokens'] as const,
  cloudSession: ['cloud', 'session'] as const,
  usage: (view: string, params: Record<string, string | number | undefined> = {}) => ['usage', view, params] as const,
};
