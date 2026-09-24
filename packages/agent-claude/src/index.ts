import {
  capacityFromFailure,
  CapacityCollector,
  capture,
  CliAgentAdapter,
  dollars,
  epochSecondsToIso,
  mergeSkills,
  PROTOCOL_MAX_LINE_LENGTH,
  scanSkillDirectory,
  tokenCount,
  type AgentExecutionInput,
  type AgentHealth,
  type AgentRuntimeOptions,
  type AgentUsageLine,
  type AgentUsageReport,
  type ParserContext,
  type ProviderUsageCapabilities,
  type StreamParser,
} from '@acc/agent-sdk';
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentCapabilities, ModelDescriptor, PermissionLevel, SkillInfo } from '@acc/shared';

/** Skill names and plugin folders from a `claude -p` init event; null when none was printed. */
export function readInitEvent(stdout: string): { skills: string[]; plugins: Array<{ name: string; path: string }> } | null {
  for (const line of stdout.split('\n')) {
    if (!line.includes('"init"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; subtype?: string; skills?: unknown; plugins?: unknown };
      if (event.type !== 'system' || event.subtype !== 'init' || !Array.isArray(event.skills)) continue;
      const skills = event.skills.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200);
      const plugins = (Array.isArray(event.plugins) ? event.plugins : [])
        .filter((p): p is { name: string; path: string } => typeof p?.name === 'string' && typeof p?.path === 'string' && path.isAbsolute(p.path));
      return { skills, plugins };
    } catch {
      /* not JSON */
    }
  }
  return null;
}

/** True when a lookup's result event shows no model turn and no cost; a missing result counts as free (nothing was sent). */
export function lookupWasFree(stdout: string): boolean {
  for (const line of stdout.split('\n')) {
    if (!line.includes('"result"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; num_turns?: unknown; total_cost_usd?: unknown };
      if (event.type !== 'result') continue;
      return (event.num_turns ?? 0) === 0 && (event.total_cost_usd ?? 0) === 0;
    } catch {
      /* not JSON */
    }
  }
  return true;
}

/**
 * A plugin's skill folders: `skills/` plus whatever its manifest's `skills`
 * declares (a path or list). The CLI reads both — e.g. a manifest saying
 * `"./"` still has its skills found under `skills/`.
 */
async function pluginSkillFolders(root: string): Promise<string[]> {
  const base = path.resolve(root);
  const folders = [path.join(base, 'skills')];
  try {
    const manifest = JSON.parse(await readFile(path.join(base, '.claude-plugin', 'plugin.json'), 'utf8')) as { skills?: unknown };
    const declared = (Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills]).filter((p): p is string => typeof p === 'string');
    // Only folders inside the plugin: a manifest cannot point the scan elsewhere.
    for (const p of declared.map((d) => path.resolve(base, d))) if ((p === base || p.startsWith(base + path.sep)) && !folders.includes(p)) folders.push(p);
  } catch {
    /* no manifest: the default layout */
  }
  return folders;
}

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

/**
 * Built-in tools that exist in a run (`--tools`). The set is closed on purpose: a
 * skill's `allowed-tools` can pre-approve any tool that exists, so a tool outside
 * this set (WebFetch, Agent, PowerShell…) must not exist at all. `ToolSearch`
 * reaches the Control Center's deferred MCP tools.
 */
const BASE_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Skill', 'ToolSearch', 'TodoWrite'];
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/** Map a stage permission level to Claude Code's permission mode and tool policy. */
export function claudeToolPolicy(level: PermissionLevel): { mode: string; tools: string[]; allowed: string[]; denied: string[] } {
  if (level <= 1) {
    return { mode: 'dontAsk', tools: [...BASE_TOOLS], allowed: [...READ_TOOLS, 'Skill', ...READ_ONLY_BASH], denied: [...WRITE_TOOLS, ...ALWAYS_DENIED] };
  }
  const tools = [...BASE_TOOLS, ...EDIT_TOOLS];
  const allowed = [...READ_TOOLS, ...WRITE_TOOLS, 'Bash', 'Skill'];
  if (level === 2) return { mode: 'acceptEdits', tools, allowed, denied: [...ALWAYS_DENIED, ...GIT_WRITE, ...DEPLOY] };
  if (level === 3) return { mode: 'acceptEdits', tools, allowed, denied: [...ALWAYS_DENIED, ...DEPLOY] };
  return { mode: 'acceptEdits', tools, allowed, denied: ALWAYS_DENIED };
}

function summarizeToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  // A skill is named by `skill`; its `args` are free text and never logged.
  const value = input.skill ?? input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.description;
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
  /** Set when a `/skills` lookup used a model turn; listing then stays off (see listSkills). */
  private skillLookupSpends = false;
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

  /**
   * The skills Claude Code loads in `cwd`, as the CLI itself reports them: a
   * `claude -p` session given the local `/skills` command answers without a
   * model call (0 turns, 0 tokens — measured on 2.1.280) and its init event
   * names every skill and plugin folder. Hooks are off for this lookup, and
   * with user config off it sees only what `--setting-sources project,local`
   * sees, like a run. Descriptions come from each SKILL.md; a name the CLI
   * reports without a readable file is listed without one.
   */
  async listSkills(options: AgentRuntimeOptions, cwd: string): Promise<SkillInfo[]> {
    if (this.skillLookupSpends) return [];
    const userConfig = options.loadUserConfig !== false;
    // --model haiku only bounds the cost if a future CLI ever sends `/skills` to the model; the guard below stops that.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--settings', JSON.stringify({ disableAllHooks: true })];
    if (!userConfig) args.push('--setting-sources', 'project,local');
    const run = await this.captureCli(options, args, 30_000, { cwd, stdin: '/skills', maxLineLength: PROTOCOL_MAX_LINE_LENGTH });
    if (run && !lookupWasFree(run.stdout)) {
      // The listing must never cost a model turn: stop asking for the life of this process.
      this.skillLookupSpends = true;
      return [];
    }
    const init = run ? readInitEvent(run.stdout) : null;
    if (!init) return [];
    const configDir = options.baseEnv.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const known = mergeSkills(
      await scanSkillDirectory(path.join(cwd, '.claude', 'skills'), 'project'),
      userConfig ? await scanSkillDirectory(path.join(configDir, 'skills'), 'user') : [],
      ...(await Promise.all(init.plugins.map((plugin) => pluginSkillFolders(plugin.path).then((dirs) => Promise.all(dirs.map((dir) => scanSkillDirectory(dir, 'plugin', plugin.name))))))).flat(),
    );
    const byName = new Map(known.map((skill) => [skill.name, skill]));
    return init.skills.map((name) => {
      const found = byName.get(name);
      if (found) return found;
      const plugin = name.includes(':') ? name.slice(0, name.indexOf(':')) : null;
      return { name, description: null, source: plugin ? 'plugin' : 'builtin', plugin };
    });
  }

  /**
   * MCP config for the Control Center tools. The file names the environment
   * variables (`${VAR}`), never their values: the session token stays in the
   * process environment only.
   */
  private mcpConfigFile(input: AgentExecutionInput): string | null {
    const bridge = input.toolBridge;
    if (!bridge) return null;
    const env = Object.fromEntries(Object.keys(bridge.env).map((k) => [k, `\${${k}}`]));
    const config = { mcpServers: { [bridge.name]: { type: 'stdio', command: bridge.command, args: bridge.args, env } } };
    const file = path.join(os.tmpdir(), `acc-mcp-${input.executionId}.json`);
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    this.executionFiles.set(input.executionId, [...(this.executionFiles.get(input.executionId) ?? []), file]);
    return file;
  }

  protected buildArgs(input: AgentExecutionInput): string[] {
    const policy = claudeToolPolicy(input.permissionLevel);
    const mcpConfig = this.mcpConfigFile(input);
    // Every tool of the Control Center server is allowed here; the Control Center applies its own policy per call.
    if (mcpConfig) policy.allowed.push(`mcp__${input.toolBridge!.name}`);
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
      '--tools',
      policy.tools.join(','),
      '--allowedTools',
      policy.allowed.join(','),
      '--disallowedTools',
      policy.denied.join(','),
    ];
    if (input.model !== 'default') args.push('--model', input.model);
    if (input.effort !== 'default') args.push('--effort', input.effort);
    if (input.loadUserConfig === false) args.push('--setting-sources', 'project,local');
    // Personal MCP servers never join a run: their tools would skip the Control Center's policy.
    // Only the Control Center's own server (--mcp-config) is loaded.
    args.push('--strict-mcp-config');
    if (mcpConfig) args.push('--mcp-config', mcpConfig);
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
              const skills = Array.isArray(event.skills) ? ` · ${event.skills.length} skills` : '';
              emit('system', `Claude Code ${event.claude_code_version ?? ''} · model ${event.model ?? 'default'} · ${event.permissionMode ?? ''}${skills}`.trim());
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
