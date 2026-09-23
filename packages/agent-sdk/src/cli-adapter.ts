import { rmSync } from 'node:fs';
import os from 'node:os';
import { DEFAULT_MAX_LINE_LENGTH, runProcess, which, type ProcessHandle, type ProcessResult } from '@acc/executor';
import { sanitizeEnv } from '@acc/security';
import type { AgentCapabilities, ModelDescriptor } from '@acc/shared';
import { classifyFailureText, summarizeFailure } from './classify.js';
import {
  AgentGuardError,
  type AgentAdapter,
  type AgentDetectionResult,
  type AgentExecutionHandle,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentHealth,
  type AgentLogStream,
  type AgentRuntimeOptions,
  type RawAgentResult,
} from './contract.js';

export interface StreamParser {
  onStdout(line: string): void;
  onStderr(line: string): void;
  finish(): Omit<RawAgentResult, 'executionId' | 'process'>;
}

export interface ParserContext {
  input: AgentExecutionInput;
  emit: (stream: AgentLogStream, text: string) => void;
  /** Stop the run immediately, e.g. when the CLI reveals it is using API billing. */
  abort: (reason: string) => void;
}

export interface CaptureResult {
  stdout: string;
  stderr: string;
  result: ProcessResult;
}

const HEALTH_TTL_MS = 5 * 60 * 1000;
/**
 * Agent CLIs stream one JSON event per line, and a single event (a long final
 * answer, a large file read) easily exceeds the display limit. Events must
 * reach the parser whole; only what the parser logs is bounded for display.
 */
export const PROTOCOL_MAX_LINE_LENGTH = 32 * 1024 * 1024;

/** Run a short-lived CLI command (version, auth status) and capture its output. */
export async function capture(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
): Promise<CaptureResult> {
  const out: string[] = [];
  const err: string[] = [];
  const handle = runProcess({
    command: executable,
    args,
    cwd: os.homedir(),
    env,
    timeoutMs,
    onLine: (stream, line) => (stream === 'stdout' ? out : err).push(line),
  });
  const result = await handle.done;
  return { stdout: out.join('\n'), stderr: err.join('\n'), result };
}

/**
 * Shared machinery for CLI-backed agents: executable discovery, cached
 * health, the subscription-only launch guard, the running-execution registry
 * and result interpretation. Providers supply argv construction and output
 * parsing.
 */
export abstract class CliAgentAdapter implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly displayName: string;
  protected abstract readonly binaryName: string;

  protected abstract readVersion(executable: string, env: NodeJS.ProcessEnv): Promise<string | null>;
  protected abstract probeAuth(
    executable: string,
    env: NodeJS.ProcessEnv,
    options: AgentRuntimeOptions,
  ): Promise<Omit<AgentHealth, 'checkedAt'>>;
  protected abstract buildArgs(input: AgentExecutionInput): string[];
  protected abstract createParser(context: ParserContext): StreamParser;
  abstract getCapabilities(): Promise<AgentCapabilities>;
  abstract listModels(options: AgentRuntimeOptions): Promise<ModelDescriptor[]>;

  private readonly running = new Map<string, ProcessHandle>();
  /** Files an execution created (e.g. an MCP config); removed when it ends. */
  protected readonly executionFiles = new Map<string, string[]>();
  private healthCache: { key: string; health: AgentHealth; at: number } | null = null;

  protected async resolveExecutable(options: AgentRuntimeOptions): Promise<string | null> {
    return which(options.executablePath || this.binaryName, options.baseEnv);
  }

  async detect(options: AgentRuntimeOptions): Promise<AgentDetectionResult> {
    const executablePath = await this.resolveExecutable(options);
    if (!executablePath) {
      return {
        found: false,
        executablePath: null,
        version: null,
        error: options.executablePath
          ? `No executable at ${options.executablePath}`
          : `"${this.binaryName}" was not found on PATH`,
      };
    }
    try {
      const { env } = sanitizeEnv(options.baseEnv, options.billingMode);
      const version = await this.readVersion(executablePath, env);
      return { found: true, executablePath, version, error: version ? null : 'Version could not be read' };
    } catch (error) {
      return { found: true, executablePath, version: null, error: (error as Error).message };
    }
  }

  async healthCheck(options: AgentRuntimeOptions): Promise<AgentHealth> {
    const checkedAt = new Date().toISOString();
    const executable = await this.resolveExecutable(options);
    if (!executable) {
      return this.remember(options, {
        state: 'not_installed',
        message: `${this.displayName} CLI was not found. Install it or set its path in Settings → Agents & Models.`,
        authMethod: null,
        billing: 'unknown',
        checkedAt,
      });
    }
    const { env } = sanitizeEnv(options.baseEnv, options.billingMode);
    let health: AgentHealth;
    try {
      health = { ...(await this.probeAuth(executable, env, options)), checkedAt };
    } catch (error) {
      health = {
        state: 'error',
        message: `Health check failed: ${(error as Error).message}`,
        authMethod: null,
        billing: 'unknown',
        checkedAt,
      };
    }
    if (health.state === 'connected' && options.billingMode === 'subscription' && health.billing !== 'subscription') {
      health = {
        ...health,
        state: 'api_billing_blocked',
        message:
          health.billing === 'api'
            ? `${this.displayName} is signed in with API billing (${health.authMethod ?? 'API key'}). Subscription Only mode will not run it.`
            : `${this.displayName}'s subscription session could not be verified. Subscription Only mode will not run it.`,
      };
    }
    return this.remember(options, health);
  }

  private cacheKey(options: AgentRuntimeOptions): string {
    return `${options.billingMode}|${options.executablePath ?? ''}`;
  }

  private remember(options: AgentRuntimeOptions, health: AgentHealth): AgentHealth {
    this.healthCache = { key: this.cacheKey(options), health, at: Date.now() };
    return health;
  }

  /** Force the next launch to re-verify authentication. */
  invalidateHealth(): void {
    this.healthCache = null;
  }

  private async currentHealth(options: AgentRuntimeOptions): Promise<AgentHealth> {
    const cached = this.healthCache;
    if (cached && cached.key === this.cacheKey(options) && Date.now() - cached.at < HEALTH_TTL_MS && cached.health.state === 'connected') {
      return cached.health;
    }
    return this.healthCheck(options);
  }

  async execute(input: AgentExecutionInput): Promise<AgentExecutionHandle> {
    const health = await this.currentHealth(input);
    if (health.state !== 'connected') {
      const errorClass = health.state === 'not_installed' ? 'PROCESS_CRASH' : 'AUTH_FAILURE';
      throw new AgentGuardError(health.message, errorClass);
    }
    if (input.billingMode === 'subscription' && health.billing !== 'subscription') {
      throw new AgentGuardError(
        `${this.displayName}: subscription session could not be verified; refusing to run in Subscription Only mode.`,
        'AUTH_FAILURE',
      );
    }
    const executable = await this.resolveExecutable(input);
    if (!executable) throw new AgentGuardError(`${this.displayName} CLI was not found`, 'PROCESS_CRASH');

    const { env } = sanitizeEnv(input.baseEnv, input.billingMode);
    // The tool session token reaches the agent (and the MCP server it starts) only through its environment.
    if (input.toolBridge) Object.assign(env, input.toolBridge.env);
    const args = this.buildArgs(input);
    let guardViolation: string | null = null;
    let handle: ProcessHandle | null = null;
    const emit = (stream: AgentLogStream, text: string) => {
      for (let i = 0; i < Math.max(text.length, 1); i += DEFAULT_MAX_LINE_LENGTH) {
        input.onLine?.(stream, text.slice(i, i + DEFAULT_MAX_LINE_LENGTH));
      }
    };
    const parser = this.createParser({
      input,
      emit,
      abort: (reason) => {
        if (guardViolation) return;
        guardViolation = reason;
        emit('system', `Stopped: ${reason}`);
        void handle?.cancel();
      },
    });

    handle = runProcess({
      command: executable,
      args,
      cwd: input.cwd,
      env,
      stdin: input.prompt,
      timeoutMs: input.timeoutMs,
      maxLineLength: PROTOCOL_MAX_LINE_LENGTH,
      onLine: (stream, line) => (stream === 'stdout' ? parser.onStdout(line) : parser.onStderr(line)),
    });
    this.running.set(input.executionId, handle);

    const done = handle.done.then(async (process) => {
      this.running.delete(input.executionId);
      for (const file of this.executionFiles.get(input.executionId) ?? []) rmSync(file, { force: true });
      this.executionFiles.delete(input.executionId);
      const parsed = parser.finish();
      return this.parseResult({
        executionId: input.executionId,
        process,
        ...parsed,
        guardViolation: guardViolation ?? parsed.guardViolation,
      });
    });

    return {
      executionId: input.executionId,
      pid: handle.pid,
      commandLine: [this.binaryName, ...args].join(' '),
      done,
    };
  }

  async cancel(executionId: string): Promise<void> {
    await this.running.get(executionId)?.cancel();
  }

  async parseResult(raw: RawAgentResult): Promise<AgentExecutionResult> {
    const { process } = raw;
    const base = {
      executionId: raw.executionId,
      exitCode: process.exitCode,
      output: (raw.finalMessage ?? '').trim(),
      durationMs: process.durationMs,
      startedAt: process.startedAt.toISOString(),
      finishedAt: process.finishedAt.toISOString(),
      sessionId: raw.sessionId,
      filesChanged: raw.filesChanged,
    };

    if (raw.guardViolation) {
      return { ...base, status: 'failed', errorClass: 'AUTH_FAILURE', errorMessage: raw.guardViolation };
    }
    if (process.cancelled) {
      return { ...base, status: 'cancelled', errorClass: null, errorMessage: 'Cancelled' };
    }
    if (process.timedOut) {
      return { ...base, status: 'timed_out', errorClass: 'TIMEOUT', errorMessage: 'The agent exceeded the stage timeout' };
    }
    if (process.spawnError) {
      return { ...base, status: 'failed', errorClass: 'PROCESS_CRASH', errorMessage: process.spawnError };
    }
    const failed = process.exitCode !== 0 || raw.failureMessages.length > 0 || raw.usageLimited;
    if (!failed) return { ...base, status: 'succeeded', errorClass: null, errorMessage: null };

    // Structured failure messages from the provider outrank incidental log noise in the tail.
    const errorClass = raw.usageLimited
      ? 'USAGE_LIMIT'
      : (classifyFailureText(raw.failureMessages.join('\n')) ??
        classifyFailureText(process.tail.join('\n')) ??
        'PROCESS_CRASH');
    const message = summarizeFailure(raw.failureMessages, process.tail) || `Exited with code ${process.exitCode}`;
    return { ...base, status: 'failed', errorClass, errorMessage: message };
  }
}
