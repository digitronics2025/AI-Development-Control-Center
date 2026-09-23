import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  capacityFromFailure,
  CapacityCollector,
  capture,
  CliAgentAdapter,
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
import type { AgentCapabilities, ModelDescriptor } from '@acc/shared';

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

  protected buildArgs(input: AgentExecutionInput): string[] {
    const args = ['exec', '--json', '--color', 'never', '--skip-git-repo-check', '-C', input.cwd];
    // Level 1 stages analyse only; everything else may edit inside the workspace.
    args.push('--sandbox', input.permissionLevel <= 1 ? 'read-only' : 'workspace-write');
    if (input.model !== 'default') args.push('-m', input.model);
    if (input.effort !== 'default') args.push('-c', `model_reasoning_effort="${input.effort}"`);
    // Subscription Only: refuse any login method other than the ChatGPT session.
    if (input.billingMode === 'subscription') args.push('-c', 'forced_login_method="chatgpt"');
    if (input.loadUserConfig === false) args.push('--ignore-user-config');
    for (const image of input.images ?? []) args.push('-i', image);
    args.push('-');
    return args;
  }

  protected createParser({ emit, input }: ParserContext): StreamParser {
    let finalMessage: string | null = null;
    let sessionId: string | null = null;
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
          filesChanged: [...filesChanged],
          usage: codexUsage(turns, sessionId, input.model),
          capacity: capacity.list(),
        };
      },
    };
  }
}
