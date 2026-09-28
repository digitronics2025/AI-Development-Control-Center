import type { ProcessResult } from '@acc/executor';
import type {
  AgentCapabilities,
  AgentHealthState,
  BillingMode,
  ErrorClass,
  ModelDescriptor,
  PermissionLevel,
  SkillInfo,
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
  /** Load the user's own CLI customisations (hooks, skills, plugins). Personal MCP servers are never loaded. */
  loadUserConfig?: boolean;
  /**
   * The Control Center itself (SEC-3): its data folder and listen port, which
   * adapters deny in the agent's native permission rules (the token, database
   * and key files; the port), and folders an agent may read but never write
   * (the learned plugins). Absent: only the adapter's own rules apply.
   */
  controlCenter?: { dataDir: string; port: number | null; readOnly?: string[] };
}

export type AgentLogStream = 'stdout' | 'stderr' | 'system';

/**
 * What a provider can tell us about usage and capacity (usage accounting,
 * docs/systems/usage.md). The dashboard shows `Unavailable` for anything a
 * provider does not support instead of assuming a value.
 */
export interface ProviderUsageCapabilities {
  /** Billing provider: `anthropic`, `openai`, `simulated`. */
  provider: string;
  tokenUsage: boolean;
  providerCost: boolean;
  credit: boolean;
  quota: boolean;
  rateLimits: boolean;
  cacheTokens: boolean;
  reasoningTokens: boolean;
  resetTime: boolean;
}

/**
 * Token usage of one model inside one agent run, normalised across
 * providers. `null` means the provider did not report the value — never 0.
 */
export interface AgentUsageLine {
  /** Model identifier as the provider reported it (or as requested when it reports none). */
  model: string;
  /** Uncached input tokens (cache reads and writes are separate). */
  inputTokens: number | null;
  /** Output tokens, reasoning included. */
  outputTokens: number | null;
  cacheReadTokens: number | null;
  /** Cache writes of every duration. */
  cacheWriteTokens: number | null;
  /** The part of `cacheWriteTokens` written with a one-hour lifetime, when the provider says. */
  cacheWrite1hTokens: number | null;
  /** Reasoning tokens — a subset of `outputTokens`, informational. */
  reasoningTokens: number | null;
  /** Cost the provider itself reported for this model, in US dollars. */
  reportedCostUsd: number | null;
}

export interface AgentUsageReport {
  /** Provider-side identity of the run (session or thread id). */
  providerRequestId: string | null;
  /** Model the provider says it ran, when it says. */
  resolvedModel: string | null;
  lines: AgentUsageLine[];
  /** Model turns inside the run (a CLI run makes several API calls). */
  turns: number | null;
  apiDurationMs: number | null;
}

/** A capacity signal observed during a run: a rate-limit window, credit state, a usage limit. */
export interface CapacityObservation {
  /** Stable metric key, e.g. `window:five_hour`, `overage`, `credit`, `usage_limit`. */
  metric: string;
  label: string;
  /** Share of the window already used, 0–100, when the provider reports it. */
  usedPercent: number | null;
  status: 'ok' | 'warning' | 'exhausted' | 'unknown';
  resetsAt: string | null;
  detail: string | null;
  observedAt: string;
}

/** A run started as the Control Center's agent account (`AgentExecutionInput.runAs`). */
export interface AgentRunAs {
  /** The local Windows account, as Settings names it. */
  account: string;
  /** Its password record (`<data>/agent-account.json`), written by the privileged helper. */
  credentialFile: string;
  /** scripts/windows/agent-relay.ps1. */
  relay: string;
}

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
  /**
   * The Control Center's precheck of the agent's native shell commands and
   * file reads (SEC-3): a program the CLI runs before each one, which asks the
   * orchestrator and refuses on any error. `env` carries the run's tool
   * session, as `toolBridge.env` does, into the agent's environment only.
   * Absent: an adapter whose native shell needs it runs without one.
   */
  shellGuard?: { command: string; args: string[]; env: Record<string, string> };
  /**
   * The agent OS boundary (SEC-3, docs/systems/security.md#agent-os-boundary):
   * start the CLI as this separate local Windows account, through `relay`
   * (scripts/windows/agent-relay.ps1), which alone reads the account's password
   * from `credentialFile` (protected for the operator's Windows user). When the
   * run cannot start as that account it fails — it never runs as the operator
   * instead. Absent: the CLI starts as the operator, exactly as without it.
   */
  runAs?: AgentRunAs;
  /**
   * Skill plugins the Control Center manages (docs/systems/learning.md), loaded
   * for this run only. Adapters that cannot load plugins ignore them; the
   * prompt then names the skill files instead.
   */
  pluginDirs?: string[];
  /**
   * Where a push deploys the task's repositories (each release setting that
   * pushes; a multi-repository task has one per repository): a push there is
   * Level 5 production, which no agent may do, so adapters deny it in their
   * native shell rules too, with the production-named branches (main,
   * master…). Absent when no repository of the task releases by push.
   */
  releaseBranches?: Array<{ remote: string; branch: string }>;
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
  /**
   * Why the CLI's output did not follow the protocol the adapter knows (e.g. no
   * event that ends every successful turn). A run that would otherwise count as
   * a success fails `PROTOCOL_DRIFT` with it instead. Absent or null: no drift seen.
   */
  protocolDrift?: string | null;
  filesChanged: string[];
  usage: AgentUsageReport | null;
  capacity: CapacityObservation[];
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
  /** Usage the provider reported for this run; null when it reported none (e.g. killed before its summary). */
  usage: AgentUsageReport | null;
  /** Capacity signals seen during the run. */
  capacity: CapacityObservation[];
}

/** PLAN §9 — one contract for every provider. */
export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly usageCapabilities: ProviderUsageCapabilities;

  detect(options: AgentRuntimeOptions): Promise<AgentDetectionResult>;
  healthCheck(options: AgentRuntimeOptions): Promise<AgentHealth>;
  getCapabilities(): Promise<AgentCapabilities>;
  listModels(options: AgentRuntimeOptions): Promise<ModelDescriptor[]>;
  /**
   * Skills this CLI would load in `cwd`, named as it invokes them. Optional: an
   * agent that cannot report its skills lists none (docs/systems/agents-skills.md#skills).
   */
  listSkills?(options: AgentRuntimeOptions, cwd: string): Promise<SkillInfo[]>;

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
