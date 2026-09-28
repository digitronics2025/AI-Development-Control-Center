import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AgentGuardError,
  capacityFromFailure,
  CapacityCollector,
  capture,
  classifyFailureText,
  CliAgentAdapter,
  PROTOCOL_MAX_LINE_LENGTH,
  sumCounts,
  tokenCount,
  type AgentExecutionInput,
  type AgentHealth,
  type AgentRuntimeOptions,
  type AgentUsageReport,
  type ParserContext,
  type ProviderUsageCapabilities,
  type StreamParser,
} from '@acc/agent-sdk';
import type { AgentCapabilities, ErrorClass, ModelDescriptor } from '@acc/shared';

const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

interface CodexCachedModel {
  slug?: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  priority?: number;
  default_reasoning_level?: string;
  supported_reasoning_levels?: Array<{ effort?: string }>;
}

function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function truncate(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** Codex's `turn.failed` messages sometimes embed a JSON error body; unwrap it for display. */
function unwrapError(message: string): string {
  try {
    const parsed = JSON.parse(message) as { error?: { message?: string } };
    return parsed.error?.message ?? message;
  } catch {
    return message;
  }
}

interface CodexTurnUsage {
  input: number | null;
  cached: number | null;
  output: number | null;
  reasoning: number | null;
}

/**
 * One usage line from Codex's `turn.completed` totals. Codex (OpenAI) counts
 * cached input inside `input_tokens`, so the uncached share is the
 * difference; reasoning is part of `output_tokens`. Codex reports no cost and
 * does not name the model, so the line carries the requested model (or
 * `default` when the CLI picked it).
 */
export function codexUsage(turns: CodexTurnUsage[], threadId: string | null, requestedModel: string): AgentUsageReport | null {
  if (!turns.length) return null;
  const input = sumCounts(...turns.map((t) => t.input));
  const cached = sumCounts(...turns.map((t) => t.cached));
  return {
    providerRequestId: threadId,
    resolvedModel: null,
    lines: [
      {
        model: requestedModel,
        inputTokens: input === null ? null : Math.max(0, input - (cached ?? 0)),
        outputTokens: sumCounts(...turns.map((t) => t.output)),
        cacheReadTokens: cached,
        // OpenAI prices no cache writes; reporting them as 0 would claim a measurement Codex never made.
        cacheWriteTokens: null,
        cacheWrite1hTokens: null,
        reasoningTokens: sumCounts(...turns.map((t) => t.reasoning)),
        reportedCostUsd: null,
      },
    ],
    turns: turns.length,
    apiDurationMs: null,
  };
}

/**
 * Why a Codex run's output does not read as a finished run, or null when it
 * does. Every successful `codex exec --json` run starts a thread
 * (`thread.started`) and ends each turn with `turn.completed`, which also
 * carries its usage; a run that exited 0 without a completed turn produced
 * output this adapter does not understand (a changed event format), so it is
 * not counted as a success (`PROTOCOL_DRIFT`, applied only when nothing else
 * failed). The thread alone is not enough: it holds no turn.
 */
export function codexProtocolDrift(sawThread: boolean, sawCompletedTurn: boolean): string | null {
  if (sawCompletedTurn) return null;
  const seen = sawThread ? 'it started a thread but no turn.completed event followed' : 'neither thread.started nor turn.completed was seen';
  return `Codex finished without reporting a completed turn (${seen}): its --json output is not what the Control Center reads, so the run is not counted as a success. Check the Codex version in Settings → Agents & Models.`;
}

/**
 * Features that add MCP servers to a run on their own, measured on Codex
 * 0.156.1 (docs/systems/agents.md#mcp-servers-in-a-codex-run): `apps` starts
 * `codex_apps` (ChatGPT connectors); `plugins` starts plugin servers, including
 * those of plugins installed on the ChatGPT account, which load even with
 * --ignore-user-config; `skill_mcp_dependency_install` installs and enables
 * servers a mentioned skill asks for. A CLI that does not know one of these
 * flags refuses to start ("Unknown feature flag") rather than run without it.
 */
export const CODEX_MCP_FEATURES_OFF = ['apps', 'plugins', 'skill_mcp_dependency_install'] as const;

/** A server as `codex mcp list --json` reports it; only what isolation needs. */
export interface CodexConfiguredMcpServer {
  name: string;
  transport: { type: string };
}

const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const DISABLED_TRANSPORT: Record<string, string> = {
  stdio: 'command="acc-disabled"',
  streamable_http: 'url="http://127.0.0.1/acc-disabled"',
};

/**
 * `-c` overrides that switch off every configured MCP server except `keep`
 * (the Control Center's own). Codex has no --strict-mcp-config, and a `-c`
 * table merges into the loaded layers instead of replacing them, so each
 * server is named. The entry restates a transport of the same kind because
 * Codex refuses an entry without one — which it would be in a run where the
 * layer that defines the server is not loaded (--ignore-user-config).
 */
export function codexMcpIsolationArgs(servers: CodexConfiguredMcpServer[], keep: string | null): string[] {
  const args: string[] = [];
  for (const server of servers) {
    if (server.name === keep) continue;
    const transport = DISABLED_TRANSPORT[server.transport?.type];
    if (!MCP_SERVER_NAME.test(server.name) || !transport) {
      throw new AgentGuardError(
        `Codex reports an MCP server the Control Center cannot switch off (${JSON.stringify(server.name)}, transport ${String(server.transport?.type)}); refusing to run so it cannot join.`,
        'PERMISSION_DENIED',
      );
    }
    args.push('-c', `mcp_servers.${server.name}={enabled=false,${transport}}`);
  }
  return args;
}

export class CodexAdapter extends CliAgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  readonly usageCapabilities: ProviderUsageCapabilities = {
    provider: 'openai',
    tokenUsage: true,
    providerCost: false,
    credit: false,
    quota: false,
    rateLimits: false,
    cacheTokens: true,
    reasoningTokens: true,
    resetTime: false,
  };
  protected readonly binaryName = 'codex';

  protected async readVersion(executable: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    const { stdout, stderr } = await capture(executable, ['--version'], env);
    return /(\d+\.\d+\.\d+[\w.-]*)/.exec(`${stdout}\n${stderr}`)?.[1] ?? null;
  }

  protected async probeAuth(executable: string, env: NodeJS.ProcessEnv): Promise<Omit<AgentHealth, 'checkedAt'>> {
    const { stdout, stderr, result } = await capture(executable, ['login', 'status'], env);
    const text = `${stdout}\n${stderr}`;
    if (/logged in using chatgpt/i.test(text)) {
      return { state: 'connected', message: 'CLI detected · ChatGPT subscription session', authMethod: 'chatgpt', billing: 'subscription' };
    }
    if (/logged in using (?:an )?api key/i.test(text)) {
      return { state: 'connected', message: 'CLI detected · signed in with an API key', authMethod: 'api-key', billing: 'api' };
    }
    if (/not logged in/i.test(text) || result.exitCode !== 0) {
      return { state: 'auth_required', message: 'Codex is not signed in. Run `codex login` in a terminal.', authMethod: null, billing: 'unknown' };
    }
    return { state: 'connected', message: truncate(text), authMethod: null, billing: 'unknown' };
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      repositoryRead: true,
      repositoryWrite: true,
      commandExecution: true,
      images: true,
      interactive: true,
      nonInteractive: true,
      modelSelection: true,
      effortSelection: true,
      // Codex has no plugin folders: a learned skill reaches it as a file to read.
      pluginDirs: false,
      providerLabel: 'OpenAI (Codex)',
      maxPermissionLevel: 5,
    };
  }

  /** Codex keeps the account's model catalog in $CODEX_HOME/models_cache.json. */
  async listModels(options: AgentRuntimeOptions): Promise<ModelDescriptor[]> {
    try {
      const raw = JSON.parse(await readFile(path.join(codexHome(options.baseEnv), 'models_cache.json'), 'utf8')) as {
        models?: CodexCachedModel[];
      };
      return (raw.models ?? [])
        .filter((m): m is CodexCachedModel & { slug: string } => typeof m.slug === 'string' && m.visibility !== 'hide')
        .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
        .map((m) => {
          const efforts = (m.supported_reasoning_levels ?? [])
            .map((l) => l.effort)
            .filter((e): e is string => typeof e === 'string' && /^[a-z]+$/.test(e));
          return {
            agentId: this.id,
            modelId: m.slug,
            label: m.display_name ?? m.slug,
            efforts: efforts.length ? efforts : FALLBACK_EFFORTS,
            defaultEffort: m.default_reasoning_level ?? null,
            source: 'discovered' as const,
            description: m.description ?? null,
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * The MCP servers Codex would load in this run's folder — user, profile,
   * trusted-project, system and managed layers — as the CLI itself resolves
   * them. Plugin and app servers are not listed; the feature flags remove them.
   * Any doubt refuses the run: a server that is not switched off would join it.
   */
  private async configuredMcpServers(input: AgentExecutionInput): Promise<CodexConfiguredMcpServer[]> {
    const flags = CODEX_MCP_FEATURES_OFF.flatMap((feature) => ['--disable', feature]);
    const listed = await this.captureCli(input, ['mcp', 'list', '--json', ...flags], 30_000, {
      cwd: input.cwd,
      maxLineLength: PROTOCOL_MAX_LINE_LENGTH,
    });
    const refuse = (why: string, errorClass: ErrorClass = 'PROCESS_CRASH') =>
      new AgentGuardError(`Codex could not list its MCP servers, so the run was not started (a personal server could join it): ${why}`, errorClass);
    if (!listed) throw refuse('the CLI was not found');
    if (listed.result.exitCode !== 0) {
      const text = `${listed.stderr}\n${listed.stdout}`;
      throw refuse(truncate(text) || `exit ${listed.result.exitCode ?? 'none'}`, classifyFailureText(text) ?? 'PROCESS_CRASH');
    }
    let servers: unknown;
    try {
      servers = JSON.parse(listed.stdout);
    } catch {
      throw refuse(`unreadable output: ${truncate(listed.stdout)}`);
    }
    if (!Array.isArray(servers) || !servers.every((s) => typeof s?.name === 'string')) throw refuse(`unexpected output: ${truncate(listed.stdout)}`);
    return servers as CodexConfiguredMcpServer[];
  }

  protected async buildArgs(input: AgentExecutionInput): Promise<string[]> {
    const args = ['exec', '--json', '--color', 'never', '--skip-git-repo-check', '-C', input.cwd];
    // Only the Control Center's own MCP server may join a run: its tools go through ToolService.invoke at the stage's level.
    for (const feature of CODEX_MCP_FEATURES_OFF) args.push('--disable', feature);
    args.push(...codexMcpIsolationArgs(await this.configuredMcpServers(input), input.toolBridge?.name ?? null));
    // Level 1 stages analyse only; everything else may edit inside the workspace.
    args.push('--sandbox', input.permissionLevel <= 1 ? 'read-only' : 'workspace-write');
    // An execpolicy `allow` rule (the operator's ~/.codex/rules or the repository's .codex/rules)
    // skips approval and runs the command outside the sandbox, so the sandbox would not bound the stage.
    args.push('--ignore-rules');
    if (input.model !== 'default') args.push('-m', input.model);
    if (input.effort !== 'default') args.push('-c', `model_reasoning_effort="${input.effort}"`);
    // Subscription Only: refuse any login method other than the ChatGPT session.
    if (input.billingMode === 'subscription') args.push('-c', 'forced_login_method="chatgpt"');
    if (input.loadUserConfig === false) args.push('--ignore-user-config');
    if (input.toolBridge) {
      // TOML literal strings ('…') keep Windows paths intact; env_vars forwards the session from Codex's own environment.
      const literal = (v: string) => `'${v.replace(/'/g, '')}'`;
      const name = input.toolBridge.name;
      args.push('-c', `mcp_servers.${name}.command=${literal(input.toolBridge.command)}`);
      args.push('-c', `mcp_servers.${name}.args=[${input.toolBridge.args.map(literal).join(',')}]`);
      args.push('-c', `mcp_servers.${name}.env_vars=[${Object.keys(input.toolBridge.env).map(literal).join(',')}]`);
    }
    for (const image of input.images ?? []) args.push('-i', image);
    args.push('-');
    return args;
  }

  protected createParser({ emit, input }: ParserContext): StreamParser {
    let finalMessage: string | null = null;
    let sessionId: string | null = null;
    let threadStarted = false;
    const turns: CodexTurnUsage[] = [];
    const failureMessages: string[] = [];
    const filesChanged = new Set<string>();

    return {
      onStdout(line) {
        let event: Record<string, any>;
        try {
          event = JSON.parse(line);
        } catch {
          if (line.trim()) emit('stdout', line);
          return;
        }
        const item = event.item as Record<string, any> | undefined;
        switch (event.type) {
          case 'thread.started':
            threadStarted = true;
            sessionId = event.thread_id ?? null;
            break;
          case 'turn.completed': {
            const u = (event.usage ?? {}) as Record<string, unknown>;
            turns.push({
              input: tokenCount(u.input_tokens),
              cached: tokenCount(u.cached_input_tokens),
              output: tokenCount(u.output_tokens),
              reasoning: tokenCount(u.reasoning_output_tokens),
            });
            break;
          }
          case 'turn.failed': {
            const message = unwrapError(String(event.error?.message ?? 'Turn failed'));
            failureMessages.push(message);
            emit('stderr', message);
            break;
          }
          case 'error': {
            const message = unwrapError(String(event.message ?? 'Error'));
            failureMessages.push(message);
            emit('stderr', message);
            break;
          }
          case 'item.started':
            if (item?.type === 'command_execution') emit('stdout', `$ ${truncate(String(item.command ?? ''), 500)}`);
            break;
          case 'item.completed':
            if (!item) break;
            if (item.type === 'agent_message' && typeof item.text === 'string') {
              finalMessage = item.text;
              for (const text of item.text.split('\n')) if (text.trim()) emit('stdout', text);
            } else if (item.type === 'command_execution') {
              emit('stdout', `  exit ${item.exit_code ?? '?'} · ${truncate(String(item.command ?? ''), 200)}`);
            } else if (item.type === 'file_change') {
              for (const change of (item.changes as Array<{ path?: string; kind?: string }>) ?? []) {
                if (change.path) {
                  filesChanged.add(change.path);
                  emit('stdout', `[file] ${change.kind ?? 'update'} ${change.path}`);
                }
              }
            } else if (item.type === 'error' && item.message) {
              // Non-fatal warnings (config parse problems etc.). Fatal errors arrive as turn.failed.
              emit('stderr', `warning: ${truncate(String(item.message))}`);
            }
            break;
          default:
            break;
        }
      },
      onStderr(line) {
        if (line.trim()) emit('stderr', line);
      },
      finish() {
        // Codex exposes no limits feed; the only capacity signal is a failure that states it.
        const capacity = new CapacityCollector();
        for (const message of failureMessages) {
          const signal = capacityFromFailure(message);
          if (signal) capacity.add(signal);
        }
        return {
          finalMessage,
          failureMessages,
          sessionId,
          usageLimited: false,
          guardViolation: null,
          protocolDrift: codexProtocolDrift(threadStarted, turns.length > 0),
          filesChanged: [...filesChanged],
          usage: codexUsage(turns, sessionId, input.model),
          capacity: capacity.list(),
        };
      },
    };
  }
}
