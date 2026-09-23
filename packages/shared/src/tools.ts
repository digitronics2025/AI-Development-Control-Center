import { z } from 'zod';
import type { CommandRisk, PermissionLevel } from './constants.js';

/**
 * The Universal Tool & Autonomous Execution Layer (docs/plans/tool-layer-v2)
 * as seen by the API, the dashboard and the VS Code extension.
 */

export const POLICY_MODES = ['safe', 'autopilot', 'full'] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export const POLICY_MODE_LABEL: Record<PolicyMode, string> = {
  safe: 'Safe',
  autopilot: 'Autopilot',
  full: 'Full Autopilot+',
};

export const POLICY_MODE_DESCRIPTION: Record<PolicyMode, string> = {
  safe: 'Reads, analysis, local tests and low-risk edits run on their own; anything above Level 2 asks first.',
  autopilot: 'Investigates, edits, installs project dependencies, tests, repairs and commits on its own up to the auto-approve level.',
  full: 'Also runs pre-authorised infrastructure work (Level 4). Production and destructive actions still ask.',
};

export type ToolHealthState = 'ready' | 'missing' | 'auth_required' | 'error' | 'unchecked';

export interface ToolCapabilitySummary {
  id: string;
  title: string;
  level: PermissionLevel;
}

export interface ToolView {
  id: string;
  name: string;
  description: string;
  category: string;
  builtin: boolean;
  platforms: string[] | null;
  /** Not usable on this operating system at all. */
  unsupported: boolean;
  state: ToolHealthState;
  installed: boolean;
  version: string | null;
  path: string | null;
  message: string | null;
  auth: { required: boolean; state: 'ok' | 'missing' | 'unknown' | 'not_required'; message: string | null };
  checkedAt: string | null;
  authCheckedAt: string | null;
  capabilities: ToolCapabilitySummary[];
  lastUsedAt: string | null;
  uses: number;
}

export interface CapabilityView {
  id: string;
  title: string;
  description: string;
  category: string;
  level: PermissionLevel;
  providers: string[];
}

export const TOOL_CALL_ORIGINS = ['agent', 'engine', 'operator', 'chairman'] as const;
export type ToolCallOrigin = (typeof TOOL_CALL_ORIGINS)[number];

export const TOOL_EXECUTION_STATUSES = ['running', 'succeeded', 'failed', 'denied', 'needs_approval', 'cancelled', 'timed_out'] as const;
export type ToolExecutionStatus = (typeof TOOL_EXECUTION_STATUSES)[number];

export type ToolDecision = 'allow' | 'escalate' | 'approval' | 'deny';

export interface ToolExecution {
  id: string;
  taskId: string | null;
  stageId: string | null;
  sessionId: string | null;
  capability: string;
  providerId: string | null;
  origin: ToolCallOrigin;
  decision: ToolDecision;
  routeReason: string | null;
  permissionLevel: PermissionLevel;
  risk: CommandRisk;
  effects: string[];
  status: ToolExecutionStatus;
  /** One line: what happened. */
  summary: string | null;
  errorCode: string | null;
  /** Redacted, bounded description of the input (never full file contents). */
  inputSummary: string;
  attempt: number;
  recoveryOf: string | null;
  artifacts: Array<{ id: string; name: string }>;
  filesChanged: string[];
  networkTargets: string[];
  evidence: string[];
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

export type TaskProcessStatus = 'starting' | 'running' | 'healthy' | 'unhealthy' | 'exited' | 'stopped' | 'failed';

export interface TaskProcess {
  id: string;
  taskId: string | null;
  stageId: string | null;
  name: string;
  command: string;
  cwd: string;
  pid: number | null;
  port: number | null;
  url: string | null;
  status: TaskProcessStatus;
  startedAt: string;
  stoppedAt: string | null;
  exitCode: number | null;
  stopReason: string | null;
}

export interface TerminalSession {
  id: string;
  taskId: string | null;
  shell: string;
  cwd: string;
  pid: number | null;
  ownerKind: 'operator' | 'agent';
  status: 'running' | 'exited';
  cols: number;
  rows: number;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

export interface McpToolView {
  name: string;
  description: string;
  readOnlyHint: boolean | null;
  destructiveHint: boolean | null;
}

export interface McpServerView {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  url: string | null;
  /** Environment variable → credential name (values come from the broker). */
  envCredentials: Record<string, string>;
  enabled: boolean;
  permissionLevel: PermissionLevel;
  /** When set, only these tools are exposed. */
  allowedTools: string[] | null;
  timeoutMs: number;
  health: { ok: boolean; serverName: string | null; serverVersion: string | null; error: string | null; checkedAt: string; tools: McpToolView[] } | null;
  createdAt: string;
  updatedAt: string;
}

export const CREDENTIAL_KINDS = ['cloudflare', 'github', 'postgres', 'mysql', 'http', 'npm', 'other'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** Environment variable a credential kind is injected as, unless the credential names its own. */
export const CREDENTIAL_KIND_ENV: Record<CredentialKind, string | null> = {
  cloudflare: 'CLOUDFLARE_API_TOKEN',
  github: 'GH_TOKEN',
  postgres: 'DATABASE_URL',
  mysql: 'MYSQL_PWD',
  http: null,
  npm: 'NPM_TOKEN',
  other: null,
};

export interface CredentialView {
  id: string;
  name: string;
  kind: CredentialKind;
  envVar: string | null;
  description: string;
  /** Null = every repository. */
  repositoryIds: string[] | null;
  /** Short hash so two values can be told apart; never the value. */
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface RecoveryAttempt {
  id: string;
  taskId: string;
  stageId: string | null;
  command: string;
  category: string;
  strategy: string;
  status: 'running' | 'succeeded' | 'failed';
  detail: string;
  evidence: string | null;
  attempt: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface CapabilityEscalation {
  id: string;
  taskId: string | null;
  stageId: string | null;
  capability: string;
  decision: 'enabled' | 'denied' | 'approval';
  reason: string;
  permissionLevel: PermissionLevel;
  createdAt: string;
}

export interface CheckpointView {
  id: string;
  taskId: string;
  seq: number;
  label: string;
  reason: string;
  type: 'git' | 'database' | 'deployment';
  commit: string | null;
  head: string | null;
  stageKey: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Settings and repository configuration
// ---------------------------------------------------------------------------

export const executionSettingsSchema = z.object({
  /** How much runs without asking (V2 plan §34). Repositories may override it. */
  policyMode: z.enum(POLICY_MODES).default('autopilot'),
  /** Give agent stages the Control Center tools over MCP. */
  exposeToolsToAgents: z.boolean().default(true),
  /** Interactive terminals in the dashboard and for agents. */
  terminals: z.boolean().default(true),
  /** Repair infrastructure failures (missing dependencies, port conflicts, flaky network) in test stages. */
  autoRepair: z.boolean().default(true),
  /** Repairs per command in one stage run. */
  maxRepairAttempts: z.number().int().min(0).max(5).default(3),
  /** Gather an environment report before the first stage of a task. */
  environmentDiscovery: z.boolean().default(true),
});
export type ExecutionSettings = z.infer<typeof executionSettingsSchema>;

export const repositoryRuntimeSchema = z.object({
  /** How to start the app for verification (e.g. `pnpm dev --port 5173 --strictPort`). */
  devCommand: z.string().max(1000).nullable().default(null),
  /** Where the app answers once started. */
  devUrl: z.string().url().max(500).nullable().default(null),
  readyTimeoutSec: z.number().int().min(5).max(600).default(120),
  /** Pages the verify stage opens. */
  verifyPaths: z.array(z.string().max(300).regex(/^\//)).max(20).default(['/']),
  /** browser: real Chromium at desktop and phone widths; http: status checks only (APIs, Workers). */
  verifyMode: z.enum(['browser', 'http']).default('browser'),
});
export type RepositoryRuntime = z.infer<typeof repositoryRuntimeSchema>;

// ---------------------------------------------------------------------------
// API inputs
// ---------------------------------------------------------------------------

const envName = z.string().min(1).max(100).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Letters, digits and underscores');

export const mcpServerInputSchema = z
  .object({
    name: z.string().min(1).max(60),
    transport: z.enum(['stdio', 'http']),
    command: z.string().min(1).max(1000).nullable().optional(),
    args: z.array(z.string().max(2000)).max(50).default([]),
    url: z.string().url().max(1000).nullable().optional(),
    envCredentials: z.record(envName, z.string().min(1).max(100)).default({}),
    enabled: z.boolean().default(true),
    permissionLevel: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).default(2),
    allowedTools: z.array(z.string().min(1).max(200)).max(500).nullable().default(null),
    timeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
  })
  .refine((v) => (v.transport === 'stdio' ? Boolean(v.command) : Boolean(v.url)), { message: 'A stdio server needs a command; an HTTP server needs a URL' });
export type McpServerInput = z.input<typeof mcpServerInputSchema>;

export const credentialInputSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[\w.-]+$/, 'Letters, digits, dot, dash and underscore'),
  kind: z.enum(CREDENTIAL_KINDS),
  envVar: envName.nullable().optional(),
  description: z.string().max(300).default(''),
  repositoryIds: z.array(z.string().min(1).max(100)).max(200).nullable().default(null),
  /** Write-only: accepted here, never returned by any endpoint. */
  value: z.string().min(1).max(20_000),
});
export const credentialUpdateSchema = credentialInputSchema.partial().omit({ name: true });

export const toolSessionOpenSchema = z.object({
  /** Repository path or id the session works in. */
  repository: z.string().min(1).max(1000),
  profile: z.string().max(60).optional(),
});

export const toolCallSchema = z.object({
  capability: z.string().min(3).max(200),
  input: z.unknown().default({}),
});

export const operatorToolCallSchema = toolCallSchema.extend({
  repositoryId: z.string().min(1).max(100),
  /** A typed confirmation for Level 5 operations (the capability id). */
  confirmation: z.string().max(200).optional(),
});

export const terminalOpenSchema = z.object({
  repositoryId: z.string().min(1).max(100).optional(),
  taskId: z.string().min(1).max(100).optional(),
  shell: z.enum(['powershell', 'cmd', 'bash', 'wsl']).optional(),
  cols: z.number().int().min(20).max(400).default(120),
  rows: z.number().int().min(5).max(200).default(30),
});

export const checkpointCreateSchema = z.object({ label: z.string().min(1).max(120) });
export const checkpointRestoreSchema = z.object({ checkpointId: z.string().min(1).max(100).optional() });
