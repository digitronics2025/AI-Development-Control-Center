import {
  capacityFromFailure,
  CapacityCollector,
  capture,
  CliAgentAdapter,
  dollars,
  epochSecondsToIso,
  tokenCount,
  type AgentExecutionInput,
  type AgentHealth,
  type AgentUsageLine,
  type AgentUsageReport,
  type ParserContext,
  type ProviderUsageCapabilities,
  type StreamParser,
} from '@acc/agent-sdk';
import type { AgentCapabilities, ModelDescriptor, PermissionLevel } from '@acc/shared';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const BUILTIN_MODELS: Array<{ id: string; label: string; description: string }> = [
  { id: 'fable', label: 'Fable (latest)', description: 'Alias for the latest Fable model' },
  { id: 'opus', label: 'Opus (latest)', description: 'Alias for the latest Opus model' },
  { id: 'sonnet', label: 'Sonnet (latest)', description: 'Alias for the latest Sonnet model' },
  { id: 'haiku', label: 'Haiku (latest)', description: 'Alias for the latest Haiku model' },
];

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS'];
const READ_ONLY_BASH = ['git status', 'git diff', 'git log', 'git show', 'git branch', 'git rev-parse', 'ls'].map(
  (cmd) => `Bash(${cmd}:*)`,
);
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
/** Never allowed from an agent: the orchestrator does these itself, behind approvals. */
const ALWAYS_DENIED = ['git push --force', 'git push -f', 'git push --force-with-lease', 'git reset --hard', 'git clean', 'rm -rf'].map(
  (cmd) => `Bash(${cmd}:*)`,
);
const GIT_WRITE = ['git commit', 'git push', 'gh pr create', 'gh pr merge'].map((cmd) => `Bash(${cmd}:*)`);
const DEPLOY = ['wrangler deploy', 'wrangler publish', 'npm publish', 'pnpm publish', 'vercel', 'flyctl deploy'].map(
  (cmd) => `Bash(${cmd}:*)`,
);

/** Map a stage permission level to Claude Code's permission mode and tool policy. */
export function claudeToolPolicy(level: PermissionLevel): { mode: string; allowed: string[]; denied: string[] } {
  if (level <= 1) {
    return { mode: 'dontAsk', allowed: [...READ_TOOLS, ...READ_ONLY_BASH], denied: [...WRITE_TOOLS, ...ALWAYS_DENIED] };
  }
  const allowed = [...READ_TOOLS, ...WRITE_TOOLS, 'Bash'];
  if (level === 2) return { mode: 'acceptEdits', allowed, denied: [...ALWAYS_DENIED, ...GIT_WRITE, ...DEPLOY] };
  if (level === 3) return { mode: 'acceptEdits', allowed, denied: [...ALWAYS_DENIED, ...DEPLOY] };
  return { mode: 'acceptEdits', allowed, denied: ALWAYS_DENIED };
}

function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const value = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description;
  const text = typeof value === 'string' ? value : '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 297)}...` : flat;
}

const WINDOW_LABEL: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: 'Weekly window',
  seven_day_opus: 'Weekly Opus window',
  seven_day_sonnet: 'Weekly Sonnet window',
};

/** `five_hour` → "5-hour window"; unknown windows keep a readable form of their key. */
function windowLabel(key: string): string {
  return WINDOW_LABEL[key] ?? `${key.replace(/_/g, ' ')} window`;
}

/**
 * Capacity readings in a `rate_limit_event`. `unifiedWindows` carries the
 * subscription's utilisation per window (0–1) and when it resets; the top
 * level says whether this request was allowed and whether extra usage
 * (overage) can be bought.
 */
export function claudeCapacity(info: Record<string, any>, collector: CapacityCollector): void {
  const windows = (info.unifiedWindows ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, window] of Object.entries(windows)) {
    const utilization = typeof window?.utilization === 'number' && Number.isFinite(window.utilization) ? window.utilization : null;
    const usedPercent = utilization === null ? null : Math.min(100, Math.max(0, Math.round(utilization * 1000) / 10));
    const limited = info.status === 'rejected' && info.rateLimitType === key;
    collector.add({
      metric: `window:${key}`,
      label: windowLabel(key),
      usedPercent,
      status:
        limited || (usedPercent !== null && usedPercent >= 100)
          ? 'exhausted'
          : usedPercent === null
            ? 'unknown'
            : usedPercent >= 80
              ? 'warning'
              : 'ok',
      resetsAt: epochSecondsToIso(window?.resetsAt),
      detail: null,
    });
  }
  if (!Object.keys(windows).length && typeof info.rateLimitType === 'string') {
    // Older CLI versions report only the window that applied to this request.
    collector.add({
      metric: `window:${info.rateLimitType}`,
      label: windowLabel(info.rateLimitType),
      usedPercent: null,
      status: info.status === 'rejected' ? 'exhausted' : info.status === 'allowed_warning' ? 'warning' : 'ok',
      resetsAt: epochSecondsToIso(info.resetsAt),
      detail: null,
    });
  }
  if (typeof info.overageStatus === 'string') {
    const reason = typeof info.overageDisabledReason === 'string' ? info.overageDisabledReason.replace(/_/g, ' ') : null;
    collector.add({
      metric: 'overage',
      label: 'Extra usage',
      usedPercent: null,
      status:
        info.overageStatus === 'rejected'
          ? 'exhausted'
          : info.overageStatus === 'allowed_warning'
            ? 'warning'
            : info.overageStatus === 'allowed'
              ? 'ok'
              : 'unknown',
      resetsAt: null,
      detail: info.overageStatus === 'rejected' ? `Not available${reason ? `: ${reason}` : ''}` : reason,
    });
  }
}

/**
 * Usage from Claude Code's `result` event. `modelUsage` is cumulative per
 * model over every API call of the run (the top-level `usage` covers only
 * the last turn), so it is the source of truth; `costUSD` is the cost the
 * CLI computed at list price. The one-hour cache-write share is known only
 * when a single model ran and the last turn's `cache_creation` covers all of
 * its writes.
 */
export function claudeUsage(event: Record<string, any>, sessionId: string | null, initModel: string | null): AgentUsageReport | null {
  const perModel = (event.modelUsage ?? {}) as Record<string, Record<string, unknown>>;
  const last = (event.usage ?? {}) as Record<string, any>;
  const lines: AgentUsageLine[] = Object.entries(perModel).map(([model, u]) => ({
    model: typeof u.canonicalModel === 'string' && u.canonicalModel ? u.canonicalModel : model,
    inputTokens: tokenCount(u.inputTokens),
    outputTokens: tokenCount(u.outputTokens),
    cacheReadTokens: tokenCount(u.cacheReadInputTokens),
    cacheWriteTokens: tokenCount(u.cacheCreationInputTokens),
    cacheWrite1hTokens: null,
    reasoningTokens: tokenCount(u.thinkingTokens),
    reportedCostUsd: dollars(u.costUSD),
  }));
  if (lines.length === 1) {
    const line = lines[0]!;
    const split = last.cache_creation as Record<string, unknown> | undefined;
    const oneHour = tokenCount(split?.ephemeral_1h_input_tokens);
    const fiveMinute = tokenCount(split?.ephemeral_5m_input_tokens);
    if (line.cacheWriteTokens === 0) line.cacheWrite1hTokens = 0;
    else if (oneHour !== null && fiveMinute !== null && line.cacheWriteTokens !== null && oneHour + fiveMinute === line.cacheWriteTokens) {
      line.cacheWrite1hTokens = oneHour;
    }
  }
  if (!lines.length && Object.keys(last).length) {
    // No per-model breakdown: fall back to the last turn's usage under the init model.
    const total = tokenCount(last.cache_creation_input_tokens);
    lines.push({
      model: initModel ?? 'unknown',
      inputTokens: tokenCount(last.input_tokens),
      outputTokens: tokenCount(last.output_tokens),
      cacheReadTokens: tokenCount(last.cache_read_input_tokens),
      cacheWriteTokens: total,
      cacheWrite1hTokens: total === 0 ? 0 : tokenCount(last.cache_creation?.ephemeral_1h_input_tokens),
      reasoningTokens: tokenCount(last.output_tokens_details?.thinking_tokens),
      reportedCostUsd: dollars(event.total_cost_usd),
    });
  }
  if (!lines.length) return null;
  return {
    providerRequestId: sessionId,
    resolvedModel: initModel,
    lines,
    turns: tokenCount(event.num_turns),
    apiDurationMs: tokenCount(event.duration_api_ms),
  };
}

export class ClaudeCodeAdapter extends CliAgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  readonly usageCapabilities: ProviderUsageCapabilities = {
    provider: 'anthropic',
    tokenUsage: true,
    providerCost: true,
    credit: false,
    quota: true,
    rateLimits: true,
    cacheTokens: true,
    reasoningTokens: true,
    resetTime: true,
  };
  protected readonly binaryName = 'claude';

  protected async readVersion(executable: string, env: NodeJS.ProcessEnv): Promise<string | null> {
    const { stdout, stderr } = await capture(executable, ['--version'], env);
    return /(\d+\.\d+\.\d+[\w.-]*)/.exec(`${stdout}\n${stderr}`)?.[1] ?? null;
  }

  protected async probeAuth(executable: string, env: NodeJS.ProcessEnv): Promise<Omit<AgentHealth, 'checkedAt'>> {
    const { stdout, stderr, result } = await capture(executable, ['auth', 'status'], env);
    let status: { loggedIn?: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string } | null;
    try {
      status = JSON.parse(stdout);
    } catch {
      status = null;
    }
    if (!status) {
      const text = `${stdout}\n${stderr}`.trim();
      if (/not logged in|login/i.test(text) || result.exitCode !== 0) {
        return { state: 'auth_required', message: 'Claude Code is not signed in. Run `claude` and use /login.', authMethod: null, billing: 'unknown' };
      }
      return { state: 'connected', message: text.slice(0, 200), authMethod: null, billing: 'unknown' };
    }
    if (!status.loggedIn) {
      return { state: 'auth_required', message: 'Claude Code is not signed in. Run `claude` and use /login.', authMethod: null, billing: 'unknown' };
    }
    const method = status.authMethod ?? 'unknown';
    const provider = status.apiProvider ?? 'firstParty';
    const subscription = provider === 'firstParty' && /claude\.ai|oauth|subscription/i.test(method);
    const api = provider !== 'firstParty' || /api[_ -]?key|console|helper/i.test(method);
    const plan = status.subscriptionType ? ` (${status.subscriptionType})` : '';
    return {
      state: 'connected',
      message: subscription
        ? `CLI detected · Claude subscription session${plan}`
        : `CLI detected · ${method} via ${provider}`,
      authMethod: method,
      billing: subscription ? 'subscription' : api ? 'api' : 'unknown',
    };
  }

  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      repositoryRead: true,
      repositoryWrite: true,
      commandExecution: true,
      images: false,
      interactive: true,
      nonInteractive: true,
      modelSelection: true,
      effortSelection: true,
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return BUILTIN_MODELS.map((m) => ({
      agentId: this.id,
      modelId: m.id,
      label: m.label,
      efforts: EFFORTS,
      defaultEffort: null,
      source: 'builtin' as const,
      description: m.description,
    }));
  }

  protected buildArgs(input: AgentExecutionInput): string[] {
    const policy = claudeToolPolicy(input.permissionLevel);
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--permission-prompts',
      'none',
      '--permission-mode',
      policy.mode,
      '--allowedTools',
      policy.allowed.join(','),
      '--disallowedTools',
      policy.denied.join(','),
    ];
    if (input.model !== 'default') args.push('--model', input.model);
    if (input.effort !== 'default') args.push('--effort', input.effort);
    if (input.loadUserConfig === false) args.push('--setting-sources', 'project,local', '--strict-mcp-config');
    return args;
  }

  protected createParser({ emit, abort, input }: ParserContext): StreamParser {
    let finalMessage: string | null = null;
    let sessionId: string | null = null;
    let usageLimited = false;
    let initModel: string | null = null;
    let usage: AgentUsageReport | null = null;
    const capacity = new CapacityCollector();
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
        switch (event.type) {
          case 'system':
            if (event.subtype === 'init') {
              sessionId = event.session_id ?? null;
              initModel = typeof event.model === 'string' ? event.model : null;
              emit('system', `Claude Code ${event.claude_code_version ?? ''} · model ${event.model ?? 'default'} · ${event.permissionMode ?? ''}`.trim());
              // Runtime tripwire: the CLI itself says where its credentials came from.
              const source = event.apiKeySource;
              if (input.billingMode === 'subscription' && source && source !== 'none') {
                abort(`Claude Code reported API key billing (apiKeySource=${source}); Subscription Only mode stopped the run`);
              }
            }
            break;
          case 'rate_limit_event': {
            const info = event.rate_limit_info ?? {};
            claudeCapacity(info, capacity);
            if (info.status === 'rejected') {
              usageLimited = true;
              const reset = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : 'unknown';
              const message = `Usage limit reached (${info.rateLimitType ?? 'limit'}); resets at ${reset}`;
              failureMessages.push(message);
              emit('stderr', message);
            }
            break;
          }
          case 'assistant':
            for (const block of (event.message?.content as Array<Record<string, any>>) ?? []) {
              if (block.type === 'text' && typeof block.text === 'string') {
                for (const text of block.text.split('\n')) if (text.trim()) emit('stdout', text);
              } else if (block.type === 'tool_use') {
                const summary = summarizeToolInput(block.input);
                emit('stdout', `[tool] ${block.name}${summary ? ` ${summary}` : ''}`);
                if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(block.name) && typeof block.input?.file_path === 'string') {
                  filesChanged.add(block.input.file_path);
                }
              }
            }
            break;
          case 'user':
            for (const block of (event.message?.content as Array<Record<string, any>>) ?? []) {
              if (block.type === 'tool_result' && block.is_error) {
                const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
                emit('stderr', `tool error: ${content.replace(/\s+/g, ' ').slice(0, 300)}`);
              }
            }
            break;
          case 'result':
            finalMessage = typeof event.result === 'string' ? event.result : finalMessage;
            usage = claudeUsage(event, event.session_id ?? sessionId, initModel);
            if (event.is_error) {
              failureMessages.push(String(event.result || event.subtype || 'Claude Code reported an error'));
              if (event.api_error_status === 429) usageLimited = true;
            }
            for (const denial of (event.permission_denials as Array<Record<string, any>>) ?? []) {
              emit('stderr', `permission denied: ${denial.tool_name ?? 'tool'} ${summarizeToolInput(denial.tool_input)}`);
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
        // A usage limit stated only in an error message still counts as a capacity reading.
        const exhausted = capacity.list().some((c) => c.status === 'exhausted');
        for (const message of failureMessages) {
          const signal = capacityFromFailure(message);
          if (signal && !(signal.metric === 'usage_limit' && exhausted)) capacity.add(signal);
        }
        return {
          finalMessage,
          failureMessages,
          sessionId,
          usageLimited,
          guardViolation: null,
          filesChanged: [...filesChanged],
          usage,
          capacity: capacity.list(),
        };
      },
    };
  }
}
