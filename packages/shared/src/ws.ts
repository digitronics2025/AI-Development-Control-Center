import type {
  AgentInfo,
  Approval,
  Artifact,
  Directive,
  Execution,
  LogLine,
  Repository,
  RepositoryAutomationStatus,
  StageInstance,
  TaskEvent,
  TaskSummary,
  TestRun,
} from './types.js';
import type { Settings, WorkflowProfile } from './schemas.js';
import type { ChairmanAction, ChairmanDecision, ChairmanMessage, ChairmanState, TaskCheckpoint } from './chairman.js';
import type { CapabilityEscalation, CredentialView, McpServerView, RecoveryAttempt, TaskProcess, TerminalSession, ToolExecution, ToolView } from './tools.js';
import type { UsageEvent } from './usage.js';
import type { RemoteNodeStatus } from './remote.js';

/**
 * Messages the orchestrator pushes to every connected client. Each carries a
 * complete entity so clients upsert in place — they never have to replay a
 * diff, and a missed message is repaired by the next one or by a refetch on
 * reconnect.
 */
export type ServerMessage =
  | { type: 'hello'; version: string; serverTime: string; startedAt: string }
  | { type: 'task'; task: TaskSummary }
  | { type: 'task.deleted'; taskId: string }
  | { type: 'stage'; stage: StageInstance }
  | { type: 'event'; event: TaskEvent }
  | { type: 'execution'; execution: Execution }
  | { type: 'logs'; taskId: string; executionId: string; lines: LogLine[] }
  | { type: 'approval'; approval: Approval }
  | { type: 'directive'; directive: Directive }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'testRun'; testRun: TestRun }
  | { type: 'agents'; agents: AgentInfo[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'repository'; repository: Repository }
  | { type: 'repository.deleted'; repositoryId: string }
  | { type: 'workflow'; workflow: WorkflowProfile }
  | { type: 'workflow.deleted'; workflowId: string }
  /** A repository's Git state may have changed: clients refetch its Source Control snapshot. */
  | { type: 'sourceControl'; repositoryId: string }
  | { type: 'repositoryAutomation'; status: RepositoryAutomationStatus }
  | { type: 'chairman'; state: ChairmanState }
  | { type: 'chairman.message'; message: ChairmanMessage }
  | { type: 'chairman.decision'; decision: ChairmanDecision }
  | { type: 'chairman.action'; action: ChairmanAction }
  | { type: 'checkpoint'; checkpoint: TaskCheckpoint }
  /** A provider attempt was recorded (or re-costed): usage views refetch. */
  | { type: 'usage'; event: UsageEvent }
  // Universal tool layer (docs/plans/tool-layer-v2)
  | { type: 'tool'; tool: ToolView }
  | { type: 'toolExecution'; execution: ToolExecution }
  | { type: 'taskProcess'; process: TaskProcess }
  | { type: 'terminal'; terminal: TerminalSession }
  /** Terminal output goes only to clients that subscribed to that terminal. */
  | { type: 'terminal.output'; terminalId: string; data: string; cursor: number; /** A message to the viewer (e.g. a refused remote line), not shell output. */ notice?: boolean }
  | { type: 'mcpServer'; server: McpServerView }
  | { type: 'mcpServer.deleted'; serverId: string }
  | { type: 'credential'; credential: CredentialView }
  | { type: 'credential.deleted'; credentialId: string }
  | { type: 'recovery'; attempt: RecoveryAttempt }
  | { type: 'escalation'; escalation: CapabilityEscalation }
  /** This machine's link to the cloud control plane changed (local clients only; never relayed). */
  | { type: 'remote.status'; status: RemoteNodeStatus };

export type ServerMessageType = ServerMessage['type'];

/** Clients may only ask to be told about log lines for executions they are viewing. */
export type ClientMessage =
  | { type: 'subscribeLogs'; executionId: string }
  | { type: 'unsubscribeLogs'; executionId: string }
  | { type: 'subscribeTerminal'; terminalId: string }
  | { type: 'unsubscribeTerminal'; terminalId: string }
  | { type: 'terminal.input'; terminalId: string; data: string }
  | { type: 'terminal.resize'; terminalId: string; cols: number; rows: number }
  | { type: 'ping' };
