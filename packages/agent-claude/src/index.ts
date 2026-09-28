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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PRODUCTION_BRANCH_NAMES, type AgentCapabilities, type ModelDescriptor, type PermissionLevel, type SkillInfo } from '@acc/shared';
import { GUARDED_FILE_TOOLS } from './shell-guard.js';

export { GUARDED_FILE_TOOLS, type GuardedFileTool } from './shell-guard.js';

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

/** How a run's first log line says the init event carried no `apiKeySource`. */
const API_KEY_SOURCE_MISSING = '(not reported)';
const API_KEY_SOURCE_MISSING_REASON =
  "Claude Code did not say where its credentials come from (its init event has no apiKeySource), so Subscription Only mode cannot confirm the run uses your subscription and stopped it. Run `pnpm verify:agents --run --only claude` to see what the installed CLI reports";
const NO_INIT_EVENT_REASON =
  "Claude Code sent no init event, the event that says where its credentials come from, so Subscription Only mode cannot confirm the run uses your subscription and did not accept it. Run `pnpm verify:agents --run --only claude` to see what the installed CLI reports";
/** Events of a model turn: in a run, each comes after the init event. */
const TURN_EVENTS = new Set(['assistant', 'user', 'result', 'rate_limit_event']);

/**
 * What a run's first log line (the init event's summary) says about
 * `apiKeySource`: its value, null when the event carried none, undefined when
 * no such line was logged (the CLI printed no init event).
 */
export function loggedApiKeySource(lines: string[]): string | null | undefined {
  for (const line of lines) {
    if (!line.startsWith('Claude Code')) continue;
    const value = / · apiKeySource (.+?)(?: · \d+ skills)?$/.exec(line)?.[1];
    if (value !== undefined) return value === API_KEY_SOURCE_MISSING ? null : value;
  }
  return undefined;
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
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
/** Never allowed from an agent: the orchestrator does these itself, behind approvals. */
// Prefix rules on Claude Code's native Bash, not the Control Center's classifier: they catch the
// usual spellings of commands that destroy work or history (audit F-12); ToolService judges the rest.
const ALWAYS_DENIED = [
  'git push --force',
  'git push -f',
  'git push --force-with-lease',
  'git push --mirror',
  'git reset --hard',
  'git clean',
  'git restore',
  'git checkout --',
  'git checkout .',
  'git checkout -f',
  'git switch --discard-changes',
  'git stash drop',
  'git stash clear',
  'git branch -D',
  'git worktree remove',
  'git filter-branch',
  'rm -rf',
  'rm -r',
  'rmdir /s',
  'rd /s',
  'del /s',
  'Remove-Item',
  'npx rimraf',
].map(
  (cmd) => `Bash(${cmd}:*)`,
);
const GIT_WRITE = ['git commit', 'git push', 'gh pr create', 'gh pr merge'].map((cmd) => `Bash(${cmd}:*)`);
const DEPLOY = ['wrangler deploy', 'wrangler publish', 'npm publish', 'pnpm publish', 'vercel', 'flyctl deploy'].map(
  (cmd) => `Bash(${cmd}:*)`,
);
/**
 * From Level 3 an agent may push, but a push to a branch that deploys — a
 * repository's release branch, or a production-named one (main, master,
 * production…) as the `git.push` tool rates it — or a pull-request merge, is
 * a production deploy (Level 5, which no agent runs): denied from Level 3
 * (SEC-1). Prefix rules catch the usual spellings (`git push origin main`,
 * `HEAD:main`, with `-u` / `--set-upstream`): each release branch on its own
 * remote, the production-named branches on `origin`. Another source (`git
 * push origin topic:main`), `HEAD:refs/heads/main`, a bare `git push` with
 * such an upstream, or a production name on another remote is not a prefix
 * they name.
 *
 * The set stays small on purpose: an npm-installed `claude` is `claude.cmd`
 * on Windows, run through cmd.exe, which refuses a command line over 8191
 * characters (each rule's spaces and brackets are escaped there too), so a
 * rule per remote × branch × spelling would stop a multi-repository run from
 * starting.
 */
function releaseDenied(releases: AgentExecutionInput['releaseBranches']): string[] {
  const targets = new Map<string, { remote: string; branch: string }>();
  const add = (remote: string, branch: string) => targets.set(`${remote}\0${branch}`, { remote, branch });
  for (const branch of PRODUCTION_BRANCH_NAMES) add('origin', branch);
  for (const r of releases ?? []) add(r.remote, r.branch);
  const pushes = [...targets.values()].flatMap(({ remote, branch }) =>
    ['', '-u ', '--set-upstream '].flatMap((flag) => [branch, `HEAD:${branch}`].map((dst) => `git push ${flag}${remote} ${dst}`)),
  );
  return ['gh pr merge', ...pushes].map((cmd) => `Bash(${cmd}:*)`);
}

/**
 * Built-in tools that exist in a run (`--tools`). The set is closed on purpose: a
 * skill's `allowed-tools` can pre-approve any tool that exists, so a tool outside
 * this set (WebFetch, Agent, PowerShell…) must not exist at all. `ToolSearch`
 * reaches the Control Center's deferred MCP tools.
 */
const BASE_TOOLS = ['Read', 'Grep', 'Glob', 'Skill', 'ToolSearch', 'TodoWrite'];
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/** A path as a permission rule names it (`//` absolute): the CLI's POSIX form on Windows, `//c/Users/x` for `C:\Users\x`. */
export function rulePath(p: string): string {
  const posix = path.resolve(p).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, drive: string) => `/${drive.toLowerCase()}`);
  return `/${posix.replace(/\/+$/, '')}`;
}

/**
 * Native rules for the Control Center itself (SEC-3), at every level. Its
 * token, database and key files can be neither read nor written by Claude's
 * own tools (Read and Edit rules also cover the file commands the CLI
 * recognises in Bash and Bash redirection targets); Bash may not name the
 * token or the listen port; a folder agents may read but never write (the
 * learned plugins) gets an Edit rule; and Claude Code's own settings files
 * cannot be edited, so a run cannot switch its hooks off. The files only, not
 * the whole data folder: its learned plugins and task attachments are read.
 * Few rules on purpose (cmd.exe's line limit, `releaseDenied`), and lexical
 * like every rule: a command that computes a path is not seen — the precheck
 * hook reads more (from Level 2 it also judges Read, Grep and Glob, and there
 * these Read rules become `ask` rules behind it; at Level 1 they are the only
 * guard), and only an OS boundary is a boundary.
 */
export function controlCenterDenied(cc: AgentRuntimeOptions['controlCenter']): string[] {
  const rules = ['Edit(**/.claude/settings*.json)', 'Write(**/.claude/settings*.json)', 'Edit(~/.claude/settings*.json)', 'Bash(*auth-token*)'];
  if (!cc) return rules;
  const data = rulePath(cc.dataDir);
  for (const file of ['auth-token', '*.db*', 'credential-key*', 'privileged-key*']) rules.push(`Read(${data}/${file})`);
  // Writes: every file at the data folder's top (the four above, runtime.json) in one rule; its folders are not files.
  rules.push(`Edit(${data}/*)`);
  for (const dir of cc.readOnly ?? []) rules.push(`Edit(${rulePath(dir)}/**)`);
  if (cc.port) rules.push(`Bash(*127.0.0.1:${cc.port}*)`, `Bash(*localhost:${cc.port}*)`);
  return rules;
}

/**
 * The shell check's own folder is read-only for the run it guards (SEC-3): a
 * run that could rewrite, replace or remove the hook's script would switch the
 * check off for itself and every later run. One Edit rule per folder of the
 * guard's script (it covers Bash redirection targets too); the precheck
 * refuses the other commands that name it.
 */
export function shellGuardDenied(guard: NonNullable<AgentExecutionInput['shellGuard']>): string[] {
  return [...new Set(guard.args.filter((part) => path.isAbsolute(part)).map((part) => `Edit(${rulePath(path.dirname(part))}/**)`))];
}

/**
 * Map a stage permission level to Claude Code's permission mode and tool policy.
 *
 * Settings files the run loads (the repository's `.claude/settings.json` and
 * `settings.local.json`, the operator's own with user config on) add their
 * `permissions.allow` rules to ours: a repository allowing `Bash(*)` allows
 * every command. Only a deny rule or a missing tool beats an allow rule. From
 * Level 2 every limit is a deny rule and Bash and edits are already allowed, so
 * such a rule widens nothing. Level 1's limit — read-only commands only — cannot
 * be written as deny rules, so Level 1 has no shell at all: it reads Git through
 * the Control Center's own `git.*` tools, which ToolService judges. `shell:
 * false` takes the shell away from Level 2 and up too (its precheck cannot run:
 * `nativeShellRefusal`); `controlCenter` adds `controlCenterDenied`, and `guard`
 * (with the shell on) `shellGuardDenied`.
 */
export function claudeToolPolicy(
  level: PermissionLevel,
  releases?: AgentExecutionInput['releaseBranches'],
  opts: { shell?: boolean; controlCenter?: AgentRuntimeOptions['controlCenter']; guard?: AgentExecutionInput['shellGuard'] } = {},
): { mode: string; tools: string[]; allowed: string[]; denied: string[]; asked: string[] } {
  const own = controlCenterDenied(opts.controlCenter);
  if (level <= 1) {
    // No shell and no edits: only the read rules add anything.
    return { mode: 'dontAsk', tools: [...BASE_TOOLS], allowed: [...READ_TOOLS, 'Skill'], denied: ['Bash', ...WRITE_TOOLS, ...own.filter((r) => r.startsWith('Read('))], asked: [] };
  }
  const shell = opts.shell !== false;
  const tools = [...BASE_TOOLS, ...(shell ? ['Bash'] : []), ...EDIT_TOOLS];
  const allowed = [...READ_TOOLS, ...WRITE_TOOLS, ...(shell ? ['Bash'] : []), 'Skill'];
  const bash = !shell
    ? ['Bash']
    : level === 2
      ? [...ALWAYS_DENIED, ...GIT_WRITE, ...DEPLOY]
      : level === 3
        ? [...ALWAYS_DENIED, ...DEPLOY, ...releaseDenied(releases)]
        : [...ALWAYS_DENIED, ...releaseDenied(releases)];
  const hooked = shell && Boolean(opts.guard);
  const guarded = hooked ? shellGuardDenied(opts.guard!) : [];
  // With the precheck hook, the data folder's Read rules are `ask`, not `deny`: the CLI applies a
  // Read deny rule before the hook (measured on 2.1.283), so the refusal would carry neither the
  // Control Center's reason nor its audit row. An `ask` rule lets the hook refuse first, and if the
  // hook cannot start, `--permission-prompts none` still refuses what would ask (see shellGuardSettings).
  const reads = own.filter((r) => r.startsWith('Read('));
  const kept = own.filter((r) => (shell || !r.startsWith('Bash(')) && !(hooked && r.startsWith('Read(')));
  return { mode: 'acceptEdits', tools, allowed, denied: [...bash, ...kept, ...guarded], asked: hooked ? reads : [] };
}

/**
 * The built native shell precheck hook (`shell-guard-hook.ts`), beside the
 * orchestrator's bundle. `.mjs`: Node loads it as ESM whatever a package.json
 * above it says, so no file outside its own (read-only) folder decides whether it runs.
 */
export const SHELL_GUARD_SCRIPT = 'acc-shell-guard.mjs';
/** Seconds the CLI waits for the hook; the hook refuses on its own well before (`SHELL_GUARD_DEADLINE_MS`). */
const SHELL_GUARD_TIMEOUT_S = 60;

/**
 * Characters cmd.exe reads as operators. An npm-installed `claude` is
 * `claude.cmd`, which reads its arguments again (`%*`) outside cross-spawn's
 * escaping: a bare `|` in the JSON ran the rest of it as a command (measured).
 * In JSON they only ever sit inside a string, where a `\u` escape reads the same.
 */
const CMD_OPERATORS = /[|&<>^]/g;

/**
 * `--settings` from Level 2 (SEC-3): one PreToolUse command hook on
 * `Bash|Read|Grep|Glob` (`GUARDED_FILE_TOOLS`) that asks the Control Center
 * about each native shell command and each native file read before it runs,
 * and `disableAllHooks: false` beside it, so hooks stay on (the operator's own
 * guards with them) wherever the flag's settings decide. One entry, not one
 * per tool: the command line has a length limit (`releaseDenied`). A command
 * hook, not an `http` one: the CLI lets a call through when an http hook
 * fails, and the script refuses on every error. Inline JSON, never a file an
 * agent could edit, with cmd.exe's operators escaped (`CMD_OPERATORS`).
 * `ask` holds the data folder's Read rules (`claudeToolPolicy`): the hook
 * refuses such a read with the Control Center's reason and row, and should the
 * hook fail to start, the rule asks, which `--permission-prompts none` refuses.
 */
export function shellGuardSettings(guard: NonNullable<AgentExecutionInput['shellGuard']>, ask: string[] = []): string {
  const command = [guard.command, ...guard.args].map((part) => `"${part.replace(/\\/g, '/')}"`).join(' ');
  const settings = {
    disableAllHooks: false,
    hooks: { PreToolUse: [{ matcher: ['Bash', ...GUARDED_FILE_TOOLS].join('|'), hooks: [{ type: 'command', command, timeout: SHELL_GUARD_TIMEOUT_S }] }] },
    ...(ask.length ? { permissions: { ask } } : {}),
  };
  return JSON.stringify(settings).replace(CMD_OPERATORS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Why a Level 2+ run gets no native shell, or null when it does (SEC-3). The
 * shell is there only with its precheck: without a guard (tools not built
 * here), with the guard's program missing (the CLI lets a call through when a
 * hook fails to start), or in a repository whose settings set
 * `disableAllHooks` — which would switch the hook off (and the operator's own
 * hooks with it) — the run fails closed: no Bash, edits and reads as usual.
 */
export function nativeShellRefusal(input: Pick<AgentExecutionInput, 'permissionLevel' | 'shellGuard' | 'cwd'>): string | null {
  if (input.permissionLevel <= 1) return null;
  const guard = input.shellGuard;
  if (!guard) return "No native shell in this run: the Control Center's check of shell commands is not available here (the orchestrator is not built, or not listening yet).";
  const missing = [guard.command, ...guard.args].find((part) => path.isAbsolute(part) && !existsSync(part));
  if (missing) return `No native shell in this run: the Control Center's shell check program is missing (${missing}).`;
  const switches = repositoryHookSwitches(input.cwd);
  if (switches.length) return `No native shell in this run: this repository's ${switches.join(' and ')} sets disableAllHooks, which would switch off the Control Center's check of shell commands (and your own Claude Code hooks). Remove that setting to give agents a shell again.`;
  return null;
}

/**
 * `--settings` that switches every hook off: those of settings files, plugins and
 * skills' frontmatter. A `true` from any source wins over a `false` from another
 * (measured on 2.1.283), so a repository cannot turn its hooks back on.
 */
const NO_HOOKS = JSON.stringify({ disableAllHooks: true });

/**
 * The repository's own settings files that set `disableAllHooks: true`. Such a
 * file switches off every hook of the run, the operator's own included (their
 * secret guards), for the same reason a repository cannot undo `NO_HOOKS` — and
 * the Control Center's shell precheck with them, so a Level 2+ run there gets no
 * native shell (`nativeShellRefusal`). A file that does not parse is skipped, as
 * the CLI skips it.
 */
export function repositoryHookSwitches(cwd: string): string[] {
  return ['settings.json', 'settings.local.json']
    .filter((name) => {
      try {
        return (JSON.parse(readFileSync(path.join(cwd, '.claude', name), 'utf8')) as { disableAllHooks?: unknown } | null)?.disableAllHooks === true;
      } catch {
        return false;
      }
    })
    .map((name) => `.claude/${name}`);
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
  /** Why a run launched without a native shell (`nativeShellRefusal`), for its log; by execution. */
  private readonly noShell = new Map<string, string>();
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
      // --plugin-dir per folder (buildArgs).
      pluginDirs: true,
      providerLabel: 'Anthropic (Claude Code)',
      maxPermissionLevel: 5,
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
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--settings', NO_HOOKS];
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
   * process environment only. A run as the agent account (`runAs`) gets the
   * same JSON inline instead: that account cannot open the operator's temp folder.
   */
  private mcpConfigFile(input: AgentExecutionInput): string | null {
    const bridge = input.toolBridge;
    if (!bridge) return null;
    const env = Object.fromEntries(Object.keys(bridge.env).map((k) => [k, `\${${k}}`]));
    const config = { mcpServers: { [bridge.name]: { type: 'stdio', command: bridge.command, args: bridge.args, env } } };
    if (input.runAs) return JSON.stringify(config);
    const file = path.join(os.tmpdir(), `acc-mcp-${input.executionId}.json`);
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    this.executionFiles.set(input.executionId, [...(this.executionFiles.get(input.executionId) ?? []), file]);
    return file;
  }

  protected buildArgs(input: AgentExecutionInput): string[] {
    // From Level 2 the native shell exists only with the Control Center's precheck hook (SEC-3).
    const noShell = nativeShellRefusal(input);
    if (noShell) this.noShell.set(input.executionId, noShell);
    const policy = claudeToolPolicy(input.permissionLevel, input.releaseBranches, { shell: !noShell, controlCenter: input.controlCenter, guard: input.shellGuard });
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
    // Level 1 runs no hooks. A repository's hooks — its settings files, its skills, or one an
    // earlier stage wrote — are shell commands outside every permission rule, and `-p` runs them
    // in trusted and untrusted folders alike. From Level 2 the agent has a shell anyway, and the
    // switch would also take the operator's own hooks (their secret guards) away; instead the
    // Control Center's own hook checks every native shell command and file read. Level 1 cannot
    // have it without the repository's hooks, so its reads keep only the deny rules.
    if (input.permissionLevel <= 1) args.push('--settings', NO_HOOKS);
    else if (!noShell && input.shellGuard) args.push('--settings', shellGuardSettings(input.shellGuard, policy.asked));
    // Personal MCP servers never join a run: their tools would skip the Control Center's policy.
    // Only the Control Center's own server (--mcp-config) is loaded.
    args.push('--strict-mcp-config');
    if (mcpConfig) args.push('--mcp-config', mcpConfig);
    // Learned skills (docs/systems/learning.md): the Control Center's own plugin folders, for this run only.
    for (const dir of input.pluginDirs ?? []) args.push('--plugin-dir', dir);
    return args;
  }

  protected createParser({ emit, abort, input }: ParserContext): StreamParser {
    let finalMessage: string | null = null;
    let sessionId: string | null = null;
    let usageLimited = false;
    let initModel: string | null = null;
    let initSeen = false;
    let usage: AgentUsageReport | null = null;
    const capacity = new CapacityCollector();
    const failureMessages: string[] = [];
    const filesChanged = new Set<string>();
    // The run started without a shell (SEC-3): say why, first thing in its log.
    const noShell = this.noShell.get(input.executionId);
    this.noShell.delete(input.executionId);
    if (noShell) emit('system', noShell);

    return {
      onStdout(line) {
        let event: Record<string, any>;
        try {
          event = JSON.parse(line);
        } catch {
          if (line.trim()) emit('stdout', line);
          return;
        }
        // The tripwire below never ran: a turn without an init event is stopped like one without apiKeySource.
        if (input.billingMode === 'subscription' && !initSeen && TURN_EVENTS.has(event.type)) abort(NO_INIT_EVENT_REASON);
        switch (event.type) {
          case 'system':
            if (event.subtype === 'init') {
              initSeen = true;
              sessionId = event.session_id ?? null;
              initModel = typeof event.model === 'string' ? event.model : null;
              const source = typeof event.apiKeySource === 'string' && event.apiKeySource ? event.apiKeySource : null;
              const facts = [
                `Claude Code ${event.claude_code_version ?? ''}`.trim(),
                `model ${event.model ?? 'default'}`,
                typeof event.permissionMode === 'string' ? event.permissionMode : '',
                `apiKeySource ${source ?? API_KEY_SOURCE_MISSING}`,
                Array.isArray(event.skills) ? `${event.skills.length} skills` : '',
              ];
              emit('system', facts.filter(Boolean).join(' · '));
              // Runtime tripwire: the CLI itself says where its credentials came from ('none' is the subscription
              // login). It fails closed: a CLI that stops saying so cannot be told apart from one billing an API key.
              if (input.billingMode === 'subscription') {
                if (!source) abort(API_KEY_SOURCE_MISSING_REASON);
                else if (source !== 'none') abort(`Claude Code reported API key billing (apiKeySource=${source}); Subscription Only mode stopped the run`);
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
          // An exit 0 with no event at all is not a success either (a run that failed keeps its own class).
          protocolDrift: input.billingMode === 'subscription' && !initSeen ? NO_INIT_EVENT_REASON : null,
          filesChanged: [...filesChanged],
          usage,
          capacity: capacity.list(),
        };
      },
    };
  }
}
