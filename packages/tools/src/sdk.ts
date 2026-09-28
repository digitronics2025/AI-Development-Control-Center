import type { ShellInfo, ShellKind, StreamName } from '@acc/executor';
import type { CommandEffect, OutboundRequest } from '@acc/security';
import { PRODUCTION_BRANCH_NAMES, type CommandRisk, type PermissionLevel } from '@acc/shared';
import type { z } from 'zod';

/**
 * The Universal Tool SDK (V2 plan §7). A **provider** is something the
 * machine has (Git, PowerShell, Playwright, Wrangler…); it offers
 * **operations**, and an operation's id is the capability an agent asks for
 * (`git.status`, `network.port_owner`). Operations are provider-neutral:
 * several providers may offer the same capability and the router picks one.
 */

export const TOOL_CATEGORIES = [
  'shell',
  'filesystem',
  'git',
  'github',
  'runtime',
  'browser',
  'http',
  'network',
  'windows',
  'cloudflare',
  'database',
  'docker',
  'android',
  'editor',
  'process',
  'terminal',
  'checkpoint',
  'verification',
  'environment',
  'mcp',
  'media',
  'system',
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export type AuthState = 'ok' | 'missing' | 'unknown' | 'not_required';

export interface ToolDetection {
  installed: boolean;
  version: string | null;
  /** Executable or module location; null for built-in providers. */
  path: string | null;
  /** Some providers need an account (gh, wrangler); checked only on request because it is slow. */
  auth: { required: boolean; state: AuthState; message: string | null };
  /** Why it is not installed or not usable, or a note on how it was found. */
  message: string | null;
}

export interface ToolRisk {
  level: PermissionLevel;
  risk: CommandRisk;
  reasons: string[];
  effects: CommandEffect[];
  production: boolean;
  /**
   * False only when the call cannot change anything anywhere. Read-only
   * sessions (docs/systems/ask.md) run a call only when this is false; an
   * operation that does not say so is treated as a write.
   */
  writes?: boolean;
}

export interface DetectContext {
  env: NodeJS.ProcessEnv;
  /** Repository root when detection is repository-specific (e.g. a local wrangler). */
  cwd: string | null;
  shell(kind: ShellKind): Promise<ShellInfo | null>;
  tempDir: string;
}

export interface ClassifyContext {
  cwd: string;
  /** Whether a pid was started by this task (only those may be stopped at low risk). */
  isTaskOwnedPid?: (pid: number) => boolean;
  /**
   * The branches a push to which deploys this call's repository (its release
   * setting, docs/systems/release.md): one for a call in a repository, every
   * repository's for a call at the root of a multi-repository workspace,
   * empty when none releases by push.
   */
  releaseBranches?: readonly string[];
}

/** Branch names that are production on nearly every Git-connected host (Pages, Vercel, Netlify): classified production without asking. */
export const PRODUCTION_BRANCH = new RegExp(`^(?:${PRODUCTION_BRANCH_NAMES.join('|')})$`, 'i');

/** Long-running processes the orchestrator owns on behalf of a task. */
export interface ProcessHost {
  start(input: { name: string; command: string; shell?: ShellKind; cwd: string; port?: number | null; readyUrl?: string | null; readyTimeoutSec?: number; env?: Record<string, string> }): Promise<ManagedProcessInfo>;
  stop(id: string, reason?: string): Promise<ManagedProcessInfo>;
  list(): ManagedProcessInfo[];
  logs(id: string, lines: number): string[];
  isTaskOwnedPid(pid: number): boolean;
}

export interface ManagedProcessInfo {
  id: string;
  name: string;
  command: string;
  pid: number | null;
  port: number | null;
  url: string | null;
  status: 'starting' | 'running' | 'healthy' | 'unhealthy' | 'exited' | 'stopped' | 'failed';
  startedAt: string;
  exitCode: number | null;
}

export interface TerminalHost {
  start(input: { shell: ShellKind; cwd: string; cols?: number; rows?: number }): Promise<{ id: string; pid: number | null }>;
  send(id: string, input: string): Promise<void>;
  read(id: string, since?: number): { output: string; cursor: number; exited: boolean; exitCode: number | null };
  stop(id: string): Promise<void>;
}

export interface CheckpointHost {
  create(label: string): Promise<{ id: string; seq: number; label: string } | null>;
  list(): Array<{ id: string; seq: number; label: string; type: string; createdAt: string }>;
  restore(id: string): Promise<{ restored: number; removed: number; skipped: number }>;
}

export interface ArtifactSink {
  /** Save a file produced by an operation (screenshot, log, report) with the task. */
  write(input: { name: string; type: 'screenshot' | 'browser-report' | 'tool-output' | 'environment' | 'image' | 'video'; content: string | Buffer; mime?: string }): Promise<{ id: string; name: string }>;
}

export interface CredentialHost {
  /**
   * Plaintext of a named credential, for injection into one child process. Never returned to a model.
   * With `kind`, only a credential of that kind is returned (the media tools read only `media` keys,
   * so an agent cannot have another secret sent to a vendor by naming it).
   * With `targetUrl` (a tool that sends it there as a header: `http.request`), only a credential whose
   * audience holds that URL's host is returned, unless the operator approved this very send (SEC-4).
   */
  value(name: string, opts?: { kind?: 'media'; targetUrl?: string }): Promise<string | null>;
  /** Environment for credential kinds (e.g. `cloudflare` → CLOUDFLARE_API_TOKEN). */
  envFor(kinds: readonly string[]): Promise<Record<string, string>>;
  /**
   * Generate and seal a random secret under a name, scoped to this call's
   * repository. Returns metadata only; a name already generated returns the
   * existing secret rather than a new value.
   */
  generate?(input: GenerateSecretInput): Promise<GeneratedSecret>;
  /** Why this credential may not leave the machine yet (a generated secret MyVault has not saved), or null. */
  deployGate?(name: string, target: string): Promise<string | null>;
}

export interface GenerateSecretInput {
  name: string;
  kind: 'cloudflare' | 'github' | 'postgres' | 'mysql' | 'http' | 'npm' | 'other';
  envVar: string | null;
  description: string;
  bytes: number;
  encoding: 'base64url' | 'hex';
}

export interface GeneratedSecret {
  created: boolean;
  credential: { id: string; name: string; kind: string; envVar: string | null; fingerprint: string; repositoryIds: string[] | null };
  /** MyVault link state: `pending_push` until MyVault has saved it. */
  vaultSync: string | null;
}

export interface PrivilegedHost {
  run(operation: string, params: Record<string, unknown>): Promise<{ ok: boolean; message: string }>;
}

/** Where an operation's `outbound()` reads a file the call will send: the call's own folder and roots. */
export type OutboundContext = Pick<OperationContext, 'cwd' | 'roots'>;

export interface OperationContext {
  executionId: string;
  taskId: string | null;
  /** Working directory: the task's worktree or repository, or a repository an operator chose. */
  cwd: string;
  /** Filesystem roots this call may touch; every path is confined to them. */
  roots: string[];
  /**
   * The commit the task started from in `cwd`'s repository, for tools that
   * compare against it (`security.*`); null or absent outside a task or without Git.
   */
  baseline?: string | null;
  /** Sanitized environment plus any brokered credentials for this call. */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  onLine?: (stream: StreamName | 'system', line: string) => void;
  tempDir: string;
  /** Private folder for state such as saved browser sessions (never in the repository). */
  stateDir: string;
  shell(kind: ShellKind): Promise<ShellInfo | null>;
  detection(providerId: string): ToolDetection | undefined;
  processes?: ProcessHost;
  terminals?: TerminalHost;
  checkpoints?: CheckpointHost;
  artifacts?: ArtifactSink;
  credentials?: CredentialHost;
  privileged?: PrivilegedHost;
  /** Paths holding the user's own uncommitted work; tools must not overwrite or discard them. */
  protectedPaths: readonly string[];
  /** The operator's per-model media prices (Settings → Media), for cost estimates a paid call reports. */
  prices?: Readonly<Record<string, number>>;
}

export const TOOL_ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_INSTALLED',
  'UNKNOWN_CAPABILITY',
  'OUTSIDE_ROOT',
  'PROTECTED_PATH',
  'DENIED',
  'NEEDS_APPROVAL',
  'TIMEOUT',
  'CANCELLED',
  'FAILED',
  'AUTH_REQUIRED',
  'UNAVAILABLE',
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ResultImage {
  name: string;
  mime: 'image/png' | 'image/jpeg';
  data: Buffer;
}

export interface OperationResult<O = unknown> {
  ok: boolean;
  /** One line for timelines and the model. */
  summary: string;
  output?: O;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  artifacts?: Array<{ id: string; name: string }>;
  filesChanged?: string[];
  networkTargets?: string[];
  /** Lines that count as verification evidence (what was observed, not claimed). */
  evidence?: string[];
  /** Pictures for the model to look at (a screenshot it asked for). Returned to the caller only, never stored. */
  images?: ResultImage[];
  error?: { code: ToolErrorCode; message: string };
}

export interface CostEstimate {
  usd: number;
  model: string;
  /** What is counted: `image`, `video-second`, `edit`… */
  unit: string;
  units: number;
  basis: string;
}

export interface ToolOperation<I = any, O = any> {
  /** Capability id, `<area>.<verb>`; stable, shown to agents. */
  id: string;
  title: string;
  /** What it does and when to use it — agents read this. */
  description: string;
  input: z.ZodType<I>;
  /**
   * The JSON Schema agents are shown, when it cannot be derived from `input`: an outside
   * MCP server's own schema (the call is still validated by `input`).
   */
  inputJsonSchema?: Record<string, unknown>;
  /** Permission level for the common case; `classify` may raise (or lower) it per call. */
  level: PermissionLevel;
  classify?(input: I, ctx: ClassifyContext): Partial<ToolRisk>;
  /** Credential kinds the broker injects (`cloudflare`, `github`, `postgres`). */
  credentials?: readonly string[];
  /** Never changes anything, whatever the input: callable from a read-only session. `classify` may still say `writes`. */
  readOnly?: boolean;
  /** Runs until stopped (dev servers): the call returns once it is up. */
  longRunning?: boolean;
  /**
   * Paid calls only (image and video generation): what this call is expected to
   * cost, given the operator's per-model prices. ToolService's spend gate
   * reserves it before the call and refuses the call when paid generation is off
   * or the estimate does not fit a media budget (docs/systems/design-agent.md).
   */
  estimateCost?(input: I, prices: Readonly<Record<string, number>>): CostEstimate;
  /**
   * What the call sends that its caller wrote, wherever it goes (SEC-4): the URL,
   * headers and body of `http.*`, the page `web.read` loads, the query
   * `web.search` sends, an outside MCP tool's arguments, and a credential it
   * attaches by name. Before the run, ToolService refuses an agent (and asks an
   * operator) when one carries a known secret, raw or encoded, to a host that
   * secret may not reach (a loopback one too: a local server can pass it on),
   * carries a token of a known format off this machine, or attaches a
   * credential outside its audience (docs/systems/tool-system.md). What the run
   * reads from disk and sends (`http.request`'s multipart files) is read here,
   * inside `ctx.roots`, and the run sends the bytes this check read.
   */
  outbound?(input: I, ctx: OutboundContext): OutboundRequest[] | Promise<OutboundRequest[]>;
  run(input: I, ctx: OperationContext): Promise<OperationResult<O>>;
}

export interface ToolProvider {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  /** Lower is preferred when several providers offer one capability. */
  preference?: number;
  platforms?: readonly NodeJS.Platform[];
  /** Always present (implemented in Node) — detection is not needed. */
  builtin?: boolean;
  detect(ctx: DetectContext): Promise<ToolDetection>;
  /** Slow account check (`gh auth status`, `wrangler whoami`). */
  checkAuth?(ctx: DetectContext, detection: ToolDetection): Promise<ToolDetection['auth']>;
  operations: ToolOperation[];
}

export function builtinDetection(message: string | null = null): ToolDetection {
  return { installed: true, version: null, path: null, auth: { required: false, state: 'not_required', message: null }, message };
}

export function missing(message: string): ToolDetection {
  return { installed: false, version: null, path: null, auth: { required: false, state: 'not_required', message: null }, message };
}

export function failure(code: ToolErrorCode, message: string, extra: Partial<OperationResult> = {}): OperationResult {
  return { ok: false, summary: message, error: { code, message }, ...extra };
}

/** Define an operation with its input type inferred from the schema. */
export function operation<S extends z.ZodType>(def: Omit<ToolOperation<z.output<S>, any>, 'input'> & { input: S }): ToolOperation<z.output<S>> {
  return def as unknown as ToolOperation<z.output<S>>;
}
