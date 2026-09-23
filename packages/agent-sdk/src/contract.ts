import type { ProcessResult } from '@acc/executor';
import type {
  AgentCapabilities,
  AgentHealthState,
  BillingMode,
  ErrorClass,
  ModelDescriptor,
  PermissionLevel,
} from '@acc/shared';

export interface AgentDetectionResult {
  found: boolean;
  executablePath: string | null;
  version: string | null;
  error: string | null;
}

export interface AgentHealth {
  state: AgentHealthState;
  message: string;
  authMethod: string | null;
  /** Who pays for a run: the user's subscription, metered API billing, or unknown. */
  billing: 'subscription' | 'api' | 'unknown';
  checkedAt: string;
}

export interface AgentRuntimeOptions {
  billingMode: BillingMode;
  /** Environment the orchestrator was started with; adapters sanitize it. */
  baseEnv: NodeJS.ProcessEnv;
  /** Explicit executable path from settings; otherwise PATH lookup. */
  executablePath?: string | null;
  /** Load the user's own CLI customisations (hooks, skills, MCP servers). */
  loadUserConfig?: boolean;
}

export type AgentLogStream = 'stdout' | 'stderr' | 'system';

export interface AgentExecutionInput extends AgentRuntimeOptions {
  executionId: string;
  cwd: string;
  prompt: string;
  /** `default` means "do not pass a model flag; use the CLI's configured default". */
  model: string;
  /** `default` means "do not pass an effort flag". */
  effort: string;
  permissionLevel: PermissionLevel;
  timeoutMs: number;
  images?: string[];
  /**
   * The Control Center's tools as a stdio MCP server for this run
   * (docs/plans/tool-layer-v2). `env` carries a scoped session token; it is
   * added to the agent's environment and forwarded to the server, never
   * written to disk or argv.
   */
  toolBridge?: { name: string; command: string; args: string[]; env: Record<string, string> };
  /** Human-readable, already-parsed output lines. Callers redact before persisting. */
  onLine?: (stream: AgentLogStream, text: string) => void;
}

export interface AgentExecutionHandle {
  executionId: string;
  pid: number | null;
  /** Display form of the launched command (no prompt, no secrets). */
  commandLine: string;
  done: Promise<AgentExecutionResult>;
}

/** Everything an adapter observed, before interpretation. */
export interface RawAgentResult {
  executionId: string;
  process: ProcessResult;
  finalMessage: string | null;
  failureMessages: string[];
  sessionId: string | null;
  usageLimited: boolean;
  guardViolation: string | null;
  filesChanged: string[];
}

export interface AgentExecutionResult {
  executionId: string;
  status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  exitCode: number | null;
  output: string;
  errorClass: ErrorClass | null;
  errorMessage: string | null;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  sessionId: string | null;
  filesChanged: string[];
}

/** PLAN §9 — one contract for every provider. */
export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;

  detect(options: AgentRuntimeOptions): Promise<AgentDetectionResult>;
  healthCheck(options: AgentRuntimeOptions): Promise<AgentHealth>;
  getCapabilities(): Promise<AgentCapabilities>;
  listModels(options: AgentRuntimeOptions): Promise<ModelDescriptor[]>;

  execute(input: AgentExecutionInput): Promise<AgentExecutionHandle>;
  cancel(executionId: string): Promise<void>;

  parseResult(result: RawAgentResult): Promise<AgentExecutionResult>;
}

/** Raised before launch when a run would be unsafe (e.g. API billing in subscription mode). */
export class AgentGuardError extends Error {
  constructor(
    message: string,
    readonly errorClass: ErrorClass,
  ) {
    super(message);
    this.name = 'AgentGuardError';
  }
}
