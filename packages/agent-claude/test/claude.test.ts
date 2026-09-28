import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentGuardError, type AgentExecutionInput } from '@acc/agent-sdk';
import { ClaudeCodeAdapter, claudeToolPolicy, loggedApiKeySource, lookupWasFree, readInitEvent, repositoryHookSwitches, rulePath, shellGuardSettings } from '../src/index.js';

const fixture = path.resolve(import.meta.dirname, '../../../tests/fixtures', process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude');
/** A shell guard whose program exists (this test file stands in for the built hook script). */
const guard = { command: process.execPath, args: [path.resolve(import.meta.dirname, 'claude.test.ts')], env: { ACC_TOOL_URL: 'http://127.0.0.1:1', ACC_TOOL_SESSION: 'session' } };

function input(overrides: Partial<AgentExecutionInput> & { env?: NodeJS.ProcessEnv } = {}): AgentExecutionInput {
  const { env, ...rest } = overrides;
  return {
    executionId: `exec-${Math.random().toString(36).slice(2)}`,
    cwd: os.tmpdir(),
    prompt: 'Reply PONG',
    model: 'default',
    effort: 'default',
    permissionLevel: 1,
    timeoutMs: 20_000,
    billingMode: 'subscription',
    // A subscription login: the init event says the credentials are no API key.
    baseEnv: { ...process.env, FAKE_CLAUDE_APIKEY_SOURCE: 'none', ...env },
    executablePath: fixture,
    ...rest,
  };
}

describe('ClaudeCodeAdapter', () => {
  it('detects the executable and version', async () => {
    expect(await new ClaudeCodeAdapter().detect(input())).toMatchObject({ found: true, version: '9.9.9' });
  });

  it('recognises a claude.ai session as subscription billing', async () => {
    const health = await new ClaudeCodeAdapter().healthCheck(input());
    expect(health).toMatchObject({ state: 'connected', billing: 'subscription', authMethod: 'claude.ai' });
    expect(health.message).toContain('max');
  });

  it('blocks API-key auth in subscription mode', async () => {
    const adapter = new ClaudeCodeAdapter();
    const run = input({ env: { FAKE_CLAUDE_AUTH: 'apikey' } });
    expect((await adapter.healthCheck(run)).state).toBe('api_billing_blocked');
    await expect(adapter.execute(run)).rejects.toBeInstanceOf(AgentGuardError);
  });

  it('reports a signed-out CLI', async () => {
    expect((await new ClaudeCodeAdapter().healthCheck(input({ env: { FAKE_CLAUDE_AUTH: 'none' } }))).state).toBe('auth_required');
  });

  it('runs in the selected directory with the API key stripped and the prompt on stdin', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-claude-'));
    const argsFile = path.join(cwd, 'args.json');
    const lines: string[] = [];
    const result = await (
      await new ClaudeCodeAdapter().execute(
        input({
          cwd,
          model: 'sonnet',
          effort: 'high',
          permissionLevel: 2,
          env: { ANTHROPIC_API_KEY: ['sk', 'ant', 'fake', 'value'].join('-'), FAKE_ARGS_FILE: argsFile },
          onLine: (_s, t) => lines.push(t),
        }),
      )
    ).done;
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('ENV_HAS_ANTHROPIC_KEY=no');
    expect(result.output.toLowerCase()).toContain(`cwd=${cwd.toLowerCase()}`);
    expect(result.filesChanged).toEqual(['src/b.ts']);
    expect(lines).toContain('[tool] Edit src/b.ts');
    const { args } = JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] };
    expect(args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--model', 'sonnet', '--effort', 'high']));
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args.join(' ')).not.toContain('Reply PONG');
  });

  it('closes the tool set and loads only the Control Center MCP server, with or without user config', async () => {
    const argsOf = async (overrides: Partial<AgentExecutionInput>) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-claude-'));
      const argsFile = path.join(cwd, 'args.json');
      await (await new ClaudeCodeAdapter().execute(input({ cwd, ...overrides, env: { FAKE_ARGS_FILE: argsFile } }))).done;
      return (JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] }).args;
    };
    const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1] ?? '';

    const user = await argsOf({ permissionLevel: 2, loadUserConfig: true, shellGuard: guard });
    expect(after(user, '--tools')).toBe(claudeToolPolicy(2).tools.join(','));
    expect(after(user, '--allowedTools')).toContain('Skill');
    expect(user).toContain('--strict-mcp-config');
    expect(user).not.toContain('--setting-sources');
    expect(user).not.toContain('--mcp-config');

    const isolated = await argsOf({ permissionLevel: 1, loadUserConfig: false });
    expect(after(isolated, '--tools')).toBe(claudeToolPolicy(1).tools.join(','));
    expect(after(isolated, '--setting-sources')).toBe('project,local');
    expect(isolated).toContain('--strict-mcp-config');

    const bridged = await argsOf({ permissionLevel: 2, toolBridge: { name: 'acc', command: process.execPath, args: ['bridge.js'], env: { ACC_TOOL_SESSION: 'x' } } });
    expect(after(bridged, '--allowedTools').split(',')).toContain('mcp__acc');
    expect(bridged).toContain('--mcp-config');
    expect(bridged).toContain('--strict-mcp-config');

    // Learned skills (docs/systems/learning.md): each managed plugin folder, and nothing else changes.
    const learned = await argsOf({ permissionLevel: 2, shellGuard: guard, pluginDirs: ['C:/data/learning/plugins/global', 'C:/data/learning/plugins/repo-r1'] });
    expect(learned.filter((a) => a === '--plugin-dir')).toHaveLength(2);
    expect(after(learned, '--plugin-dir')).toBe('C:/data/learning/plugins/global');
    expect(learned.at(-1)).toBe('C:/data/learning/plugins/repo-r1');
    expect(after(learned, '--tools')).toBe(claudeToolPolicy(2).tools.join(','));
    expect(user).not.toContain('--plugin-dir');
  });

  it('gives a run as the agent account its MCP configuration inline: that account cannot open the operator temp folder', () => {
    class Args extends ClaudeCodeAdapter {
      of(i: AgentExecutionInput): string[] {
        return this.buildArgs(i);
      }
    }
    const bridge = { name: 'acc', command: process.execPath, args: ['C:/acc/dist/acc-mcp.js'], env: { ACC_TOOL_URL: 'http://127.0.0.1:1', ACC_TOOL_SESSION: 'session-secret' } };
    const asOperator = new Args().of(input({ permissionLevel: 2, shellGuard: guard, toolBridge: bridge }));
    const file = asOperator[asOperator.indexOf('--mcp-config') + 1]!;
    expect(existsSync(file)).toBe(true);
    const asAgent = new Args().of(input({ permissionLevel: 2, shellGuard: guard, toolBridge: bridge, runAs: { account: 'acc-agent', credentialFile: 'C:/data/agent-account.json', relay: 'C:/acc/agent-relay.ps1' } }));
    const inline = asAgent[asAgent.indexOf('--mcp-config') + 1]!;
    expect(JSON.parse(inline)).toEqual({ ...JSON.parse(readFileSync(file, 'utf8')) });
    expect(inline).toContain('${ACC_TOOL_SESSION}');
    expect(inline).not.toContain('session-secret');
    // Everything else is the same run.
    expect(asAgent.filter((a) => a !== inline)).toEqual(asOperator.filter((a) => a !== file));
    rmSync(file, { force: true });
  });

  // A repository's .claude/settings.json allowing `Bash(*)` adds to --allowedTools; only a deny rule or a missing tool beats it.
  it("keeps every level's limits in deny rules or missing tools, so a settings file's allow rule cannot widen them", async () => {
    const bashDenials = (level: 1 | 2 | 3 | 4 | 5) => claudeToolPolicy(level).denied.filter((rule) => rule.startsWith('Bash('));

    // Level 1: no shell at all, and Bash denied outright should a future CLI ever add it back.
    const l1 = claudeToolPolicy(1);
    expect(l1.mode).toBe('dontAsk');
    expect(l1.tools).not.toContain('Bash');
    expect(l1.tools).not.toContain('PowerShell');
    expect(l1.denied).toContain('Bash');
    expect(l1.allowed.some((rule) => rule === 'Bash' || rule.startsWith('Bash('))).toBe(false);
    expect(l1.tools.filter((tool) => ['Edit', 'Write', 'NotebookEdit'].includes(tool))).toEqual([]);

    // Level 2 and up: Bash is allowed by the policy itself, so a settings allow rule adds nothing; each limit is a deny rule.
    for (const level of [2, 3, 4, 5] as const) {
      expect(claudeToolPolicy(level).tools).toContain('Bash');
      expect(claudeToolPolicy(level).allowed).toContain('Bash');
      expect(bashDenials(level)).toEqual(expect.arrayContaining(['Bash(git push --force:*)', 'Bash(git reset --hard:*)', 'Bash(rm -rf:*)']));
    }
    expect(bashDenials(2)).toEqual(expect.arrayContaining(['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(gh pr create:*)', 'Bash(wrangler deploy:*)']));
    expect(bashDenials(3)).not.toContain('Bash(git commit:*)');
    expect(bashDenials(3)).not.toContain('Bash(git push:*)');
    expect(bashDenials(3)).toContain('Bash(wrangler deploy:*)');
    expect(bashDenials(4)).not.toContain('Bash(wrangler deploy:*)');

    // What the CLI is actually given.
    const argsOf = async (permissionLevel: 1 | 2) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-claude-'));
      const argsFile = path.join(cwd, 'args.json');
      await (await new ClaudeCodeAdapter().execute(input({ cwd, permissionLevel, shellGuard: guard, env: { FAKE_ARGS_FILE: argsFile } }))).done;
      const args = (JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] }).args;
      return (flag: string) => (args[args.indexOf(flag) + 1] ?? '').split(',');
    };
    const one = await argsOf(1);
    expect(one('--tools')).toEqual(['Read', 'Grep', 'Glob', 'Skill', 'ToolSearch', 'TodoWrite']);
    expect(one('--disallowedTools')).toContain('Bash');
    expect(one('--allowedTools').filter((rule) => rule.startsWith('Bash'))).toEqual([]);
    const two = await argsOf(2);
    expect(two('--tools')).toContain('Bash');
    expect(two('--disallowedTools')).toEqual(expect.arrayContaining(['Bash(git commit:*)', 'Bash(git push:*)']));
  });

  // Hooks are shell commands outside every permission rule, and `-p` runs a repository's in trusted and untrusted folders alike (2.1.283).
  it('runs no hooks at Level 1, whatever the user config, and adds only the shell guard from Level 2', async () => {
    const argsOf = async (permissionLevel: 1 | 2 | 3 | 4 | 5, loadUserConfig?: boolean, shellGuard: AgentExecutionInput['shellGuard'] | null = guard) => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-claude-'));
      const argsFile = path.join(cwd, 'args.json');
      await (await new ClaudeCodeAdapter().execute(input({ cwd, permissionLevel, loadUserConfig, ...(shellGuard ? { shellGuard } : {}), env: { FAKE_ARGS_FILE: argsFile } }))).done;
      return (JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] }).args;
    };
    for (const loadUserConfig of [undefined, true, false]) {
      const one = await argsOf(1, loadUserConfig);
      expect(one.filter((a) => a === '--settings')).toHaveLength(1);
      expect(JSON.parse(one[one.indexOf('--settings') + 1]!)).toEqual({ disableAllHooks: true });
    }
    for (const level of [2, 3, 4, 5] as const) {
      const args = await argsOf(level);
      expect(args.filter((a) => a === '--settings')).toHaveLength(1);
      // Hooks stay on — the operator's own guards too — and one PreToolUse hook asks the Control Center about Bash and the file reads.
      const settings = args[args.indexOf('--settings') + 1]!;
      expect(JSON.parse(settings)).toEqual({
        disableAllHooks: false,
        hooks: { PreToolUse: [{ matcher: 'Bash|Read|Grep|Glob', hooks: [{ type: 'command', command: `"${process.execPath.replace(/\\/g, '/')}" "${guard.args[0]!.replace(/\\/g, '/')}"`, timeout: 60 }] }] },
      });
      // claude.cmd reads its arguments again through cmd.exe, where a bare `|` would run the rest as a command.
      expect(settings).not.toMatch(/[|&<>^]/);
      expect(args[args.indexOf('--tools') + 1]!.split(',')).toContain('Bash');
    }
    // Without a guard there is no hook to add, and no shell (below).
    expect(await argsOf(2, undefined, null)).not.toContain('--settings');
  });

  it('hands the shell guard its session through the environment only', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-claude-'));
    const argsFile = path.join(cwd, 'args.json');
    const result = await (await new ClaudeCodeAdapter().execute(input({ cwd, permissionLevel: 2, shellGuard: { ...guard, env: { ACC_TOOL_SESSION: 'guard-session-value' } }, env: { FAKE_ARGS_FILE: argsFile } }))).done;
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('TOOL_SESSION=guard-session-value');
    expect(readFileSync(argsFile, 'utf8')).not.toContain('guard-session-value');
  });

  it('fails closed to no native shell when the guard cannot run or a repository would switch hooks off (SEC-3)', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-claude-'));
    mkdirSync(path.join(cwd, '.claude'));
    const settings = (name: string, body: string) => writeFileSync(path.join(cwd, '.claude', name), body);
    const run = async (overrides: Partial<AgentExecutionInput>) => {
      const lines: string[] = [];
      const argsFile = path.join(cwd, 'args.json');
      await (await new ClaudeCodeAdapter().execute(input({ cwd, onLine: (_s, t) => lines.push(t), env: { FAKE_ARGS_FILE: argsFile }, ...overrides }))).done;
      const args = (JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] }).args;
      const list = (flag: string) => (args[args.indexOf(flag) + 1] ?? '').split(',');
      return { lines: lines.filter((l) => l.startsWith('No native shell')), tools: list('--tools'), denied: list('--disallowedTools'), settings: args.includes('--settings') };
    };
    const noShell = (r: Awaited<ReturnType<typeof run>>) => !r.tools.includes('Bash') && r.denied.includes('Bash') && !r.settings;

    // The guard's way in is open: a shell, and nothing said.
    const open = await run({ permissionLevel: 2, shellGuard: guard });
    expect(open.tools).toContain('Bash');
    expect(open.lines).toEqual([]);
    // No guard (tools not built here), or its program is missing: the CLI would let every call through.
    const unguarded = await run({ permissionLevel: 3 });
    expect(noShell(unguarded)).toBe(true);
    expect(unguarded.lines[0]).toMatch(/check of shell commands is not available/);
    const missing = await run({ permissionLevel: 2, shellGuard: { ...guard, args: [path.join(cwd, 'no-such-guard.js')] } });
    expect(noShell(missing)).toBe(true);
    expect(missing.lines[0]).toMatch(/shell check program is missing/);
    // Edits stay: only the shell goes.
    expect(unguarded.tools).toEqual(expect.arrayContaining(['Edit', 'Write', 'Read']));

    // A repository that switches hooks off would switch the guard off with them, whatever the user config.
    settings('settings.json', JSON.stringify({ disableAllHooks: true }));
    settings('settings.local.json', '{ "disableAllHooks": true,'); // does not parse, so the CLI ignores it too
    for (const loadUserConfig of [true, false]) {
      const switched = await run({ permissionLevel: 2, loadUserConfig, shellGuard: guard });
      expect(noShell(switched)).toBe(true);
      expect(switched.lines).toEqual([expect.stringContaining("this repository's .claude/settings.json sets disableAllHooks")]);
    }
    // Level 1 has no shell and no hooks anyway, and says nothing.
    expect((await run({ permissionLevel: 1, shellGuard: guard })).lines).toEqual([]);

    settings('settings.json', JSON.stringify({ disableAllHooks: false }));
    settings('settings.local.json', JSON.stringify({ disableAllHooks: true }));
    expect(repositoryHookSwitches(cwd)).toEqual(['.claude/settings.local.json']);
    settings('settings.local.json', JSON.stringify({ disableAllHooks: 'true' }));
    expect(repositoryHookSwitches(cwd)).toEqual([]);
    expect(repositoryHookSwitches(path.join(cwd, 'missing'))).toEqual([]);
  });

  it('names every skill used or refused, never its arguments', async () => {
    const lines: string[] = [];
    const result = await (await new ClaudeCodeAdapter().execute(input({ env: { FAKE_CLAUDE_SCENARIO: 'skill' }, onLine: (_s, t) => lines.push(t) }))).done;
    expect(result.status).toBe('succeeded');
    expect(lines.some((l) => l.startsWith('Claude Code 9.9.9') && l.endsWith('· 3 skills'))).toBe(true);
    expect(lines).toContain('[tool] Skill fix-bug');
    expect(lines).toContain('permission denied: Skill ship-it');
    expect(lines.join('\n')).not.toContain('private-args-text');
  });

  it('stops a run whose CLI reports API key billing (runtime tripwire)', async () => {
    const result = await (await new ClaudeCodeAdapter().execute(input({ env: { FAKE_CLAUDE_APIKEY_SOURCE: 'ANTHROPIC_API_KEY' } }))).done;
    expect(result).toMatchObject({ status: 'failed', errorClass: 'AUTH_FAILURE' });
    expect(result.errorMessage).toMatch(/API key billing/);
  });

  it('stops a subscription run whose init event does not say where its credentials come from (the tripwire fails closed)', async () => {
    const lines: string[] = [];
    const run = input({ onLine: (_s, t) => lines.push(t) });
    delete run.baseEnv.FAKE_CLAUDE_APIKEY_SOURCE; // the fake's init event then carries no apiKeySource
    const result = await (await new ClaudeCodeAdapter().execute(run)).done;
    expect(result).toMatchObject({ status: 'failed', errorClass: 'AUTH_FAILURE' });
    expect(result.errorMessage).toMatch(/did not say where its credentials come from \(its init event has no apiKeySource\)/);
    expect(loggedApiKeySource(lines)).toBeNull();
  });

  it('stops a subscription run that sends no init event at all, and never counts one as a success', async () => {
    // A renamed init event: the turn that follows is stopped at its first event.
    const lines: string[] = [];
    const renamed = await (await new ClaudeCodeAdapter().execute(input({ env: { FAKE_CLAUDE_INIT_SUBTYPE: 'session_start' }, onLine: (_s, t) => lines.push(t) }))).done;
    expect(renamed).toMatchObject({ status: 'failed', errorClass: 'AUTH_FAILURE' });
    expect(renamed.errorMessage).toMatch(/sent no init event/);
    expect(loggedApiKeySource(lines)).toBeUndefined();
    // No event at all and exit 0: not a success either.
    const silent = await (await new ClaudeCodeAdapter().execute(input({ env: { FAKE_CLAUDE_SCENARIO: 'silent' } }))).done;
    expect(silent).toMatchObject({ status: 'failed', exitCode: 0, errorClass: 'PROTOCOL_DRIFT' });
    expect(silent.errorMessage).toMatch(/sent no init event/);
    // API Mode does not depend on the init event.
    const api = await (await new ClaudeCodeAdapter().execute(input({ billingMode: 'api', env: { FAKE_CLAUDE_INIT_SUBTYPE: 'session_start' } }))).done;
    expect(api.status).toBe('succeeded');
  });

  it('leaves a missing apiKeySource alone in API billing mode, and logs what the init event said', async () => {
    const lines: string[] = [];
    const adapter = new ClaudeCodeAdapter();
    const run = input({ billingMode: 'api', onLine: (_s, t) => lines.push(t) });
    delete run.baseEnv.FAKE_CLAUDE_APIKEY_SOURCE;
    const handle = await adapter.execute(run);
    // The fake keeps going until stopped: the tripwire would stop it at once, so wait for its init line and stop it here.
    for (let i = 0; i < 200 && loggedApiKeySource(lines) === undefined; i++) await new Promise((r) => setTimeout(r, 50));
    await adapter.cancel(run.executionId);
    expect((await handle.done).status).toBe('cancelled');
    expect(lines).toContain('Claude Code 9.9.9 · model claude-test · dontAsk · apiKeySource (not reported)');

    // A subscription login says `none`, and the run succeeds.
    const said: string[] = [];
    const ok = await (await new ClaudeCodeAdapter().execute(input({ onLine: (_s, t) => said.push(t) }))).done;
    expect(ok.status).toBe('succeeded');
    expect(loggedApiKeySource(said)).toBe('none');
    expect(loggedApiKeySource(['Claude Code 2.1.283 · model opus · dontAsk · apiKeySource /login managed key · 12 skills'])).toBe('/login managed key');
    expect(loggedApiKeySource(['[tool] Read src/a.ts'])).toBeUndefined();
  });

  it('classifies a rejected rate limit as USAGE_LIMIT', async () => {
    const result = await (await new ClaudeCodeAdapter().execute(input({ env: { FAKE_CLAUDE_SCENARIO: 'usage' } }))).done;
    expect(result).toMatchObject({ status: 'failed', errorClass: 'USAGE_LIMIT' });
  });

  it('reads stream events longer than the display limit whole', async () => {
    const lines: string[] = [];
    const result = await (
      await new ClaudeCodeAdapter().execute(input({ env: { FAKE_CLAUDE_SCENARIO: 'long' }, onLine: (_s, t) => lines.push(t) }))
    ).done;
    expect(result.status).toBe('succeeded');
    expect(result.output.startsWith('## Findings')).toBe(true);
    expect(result.output.endsWith('END')).toBe(true);
    // Parsed events are summarised, never dumped raw into the log.
    expect(lines.some((l) => l.includes('"type":"result"'))).toBe(false);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(8000);
  });

  it('reports an execution error', async () => {
    const result = await (await new ClaudeCodeAdapter().execute(input({ env: { FAKE_CLAUDE_SCENARIO: 'error' } }))).done;
    expect(result).toMatchObject({ status: 'failed', errorMessage: 'Something broke' });
  });

  it('reports a silent crash as a crash, not as whatever the agent last read', async () => {
    const result = await (await new ClaudeCodeAdapter().execute(input({ env: { FAKE_CLAUDE_SCENARIO: 'crash' } }))).done;
    expect(result).toMatchObject({ status: 'failed', errorClass: 'PROCESS_CRASH', errorMessage: 'Claude Code exited with code 3 without reporting an error' });
  });

  it('cancels a running execution', async () => {
    const adapter = new ClaudeCodeAdapter();
    const run = input({ env: { FAKE_CLAUDE_SCENARIO: 'hang' } });
    const handle = await adapter.execute(run);
    setTimeout(() => void adapter.cancel(run.executionId), 500);
    expect((await handle.done).status).toBe('cancelled');
  });
});

describe('ClaudeCodeAdapter.listSkills', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'acc-claude-skills-'));
  const skill = (dir: string, name: string, description: string) => {
    mkdirSync(path.join(dir, name), { recursive: true });
    writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`);
  };
  const repo = path.join(root, 'repo');
  const config = path.join(root, 'config');
  const pluginDefault = path.join(root, 'plugins', 'dx');
  const pluginManifest = path.join(root, 'plugins', 'ui-kit');
  skill(path.join(repo, '.claude', 'skills'), 'repo-check', 'Repository skill');
  skill(path.join(config, 'skills'), 'fix-bug', 'User skill');
  skill(path.join(config, 'skills'), 'not-loaded', 'On disk but the CLI does not report it');
  skill(path.join(pluginDefault, 'skills'), 'review-pr', 'Plugin skill');
  skill(path.join(pluginManifest, 'custom', 'skills'), 'palette', 'Declared by the manifest');
  mkdirSync(path.join(pluginManifest, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(pluginManifest, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ui-kit', skills: './custom/skills/' }));
  const listing = path.join(root, 'skills.json');
  writeFileSync(
    listing,
    JSON.stringify({
      skills: ['repo-check', 'fix-bug', 'dx:review-pr', 'ui-kit:palette', 'update-config', 'other:missing'],
      plugins: [
        { name: 'dx', path: pluginDefault },
        { name: 'ui-kit', path: pluginManifest },
        { name: 'agents-md', path: 'builtin' },
      ],
    }),
  );

  it('lists exactly the skills the CLI reports, with descriptions from their files', async () => {
    const argsFile = path.join(root, 'args.json');
    const skills = await new ClaudeCodeAdapter().listSkills(input({ env: { CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_SKILLS_JSON: listing, FAKE_ARGS_FILE: argsFile }, loadUserConfig: true }), repo);
    expect(skills.map((s) => `${s.source}:${s.name}:${s.description ?? '-'}`)).toEqual([
      'project:repo-check:Repository skill',
      'user:fix-bug:User skill',
      'plugin:dx:review-pr:Plugin skill',
      'plugin:ui-kit:palette:Declared by the manifest',
      'builtin:update-config:-',
      'plugin:other:missing:-',
    ]);
    // The lookup never runs hooks, tools or personal MCP servers, and runs in the repository.
    const { args, cwd } = JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[]; cwd: string };
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({ disableAllHooks: true });
    expect(args).not.toContain('--setting-sources');
    expect(cwd.toLowerCase()).toBe(repo.toLowerCase());
  });

  it('asks the CLI as an isolated run would when user config is off', async () => {
    const argsFile = path.join(root, 'args-isolated.json');
    await new ClaudeCodeAdapter().listSkills(input({ env: { FAKE_CLAUDE_SKILLS_JSON: listing, FAKE_ARGS_FILE: argsFile }, loadUserConfig: false }), repo);
    const { args } = JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] };
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project,local');
  });

  it('stops listing for good if the lookup ever costs a model turn', async () => {
    const adapter = new ClaudeCodeAdapter();
    const argsFile = path.join(root, 'args-spend.json');
    const env = { FAKE_CLAUDE_SKILLS_JSON: listing, FAKE_CLAUDE_SKILLS_SPENDS: '1', FAKE_ARGS_FILE: argsFile };
    expect(await adapter.listSkills(input({ env }), repo)).toEqual([]);
    rmSync(argsFile);
    expect(await adapter.listSkills(input({ env }), repo)).toEqual([]);
    expect(existsSync(argsFile), 'no second lookup is started').toBe(false);
    expect(lookupWasFree('{"type":"result","num_turns":0,"total_cost_usd":0}')).toBe(true);
  });

  it('finds skills under skills/ even when the manifest declares another folder', async () => {
    const plugin = path.join(root, 'plugins', 'pw');
    skill(path.join(plugin, 'skills'), 'fix', 'Fix flaky tests');
    mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pw', skills: './' }));
    const pwListing = path.join(root, 'skills-pw.json');
    writeFileSync(pwListing, JSON.stringify({ skills: ['pw:fix'], plugins: [{ name: 'pw', path: plugin }] }));
    const skills = await new ClaudeCodeAdapter().listSkills(input({ env: { FAKE_CLAUDE_SKILLS_JSON: pwListing } }), repo);
    expect(skills).toEqual([{ name: 'pw:fix', description: 'Fix flaky tests', source: 'plugin', plugin: 'pw' }]);
  });

  it('never scans outside a plugin, whatever its manifest says', async () => {
    const outside = path.join(root, 'plugins', 'escape');
    skill(path.join(root, 'plugins', 'escape-sibling', 'skills'), 'stolen', 'Outside the plugin');
    mkdirSync(path.join(outside, '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(outside, '.claude-plugin', 'plugin.json'), JSON.stringify({ skills: ['../escape-sibling/skills', '../../'] }));
    const escapeListing = path.join(root, 'skills-escape.json');
    writeFileSync(escapeListing, JSON.stringify({ skills: ['escape:stolen'], plugins: [{ name: 'escape', path: outside }] }));
    const skills = await new ClaudeCodeAdapter().listSkills(input({ env: { FAKE_CLAUDE_SKILLS_JSON: escapeListing } }), repo);
    expect(skills).toEqual([{ name: 'escape:stolen', description: null, source: 'plugin', plugin: 'escape' }]);
  });

  it('lists nothing when the CLI is missing or prints no init event', async () => {
    expect(await new ClaudeCodeAdapter().listSkills(input({ executablePath: path.join(root, 'no-such-claude.exe') }), repo)).toEqual([]);
    expect(readInitEvent('{"type":"result"}\nnot json')).toBeNull();
  });
});

describe('claudeToolPolicy', () => {
  it('keeps analysis read-only and never allows force push', () => {
    const l1 = claudeToolPolicy(1);
    expect(l1.mode).toBe('dontAsk');
    expect(l1.allowed).not.toContain('Edit');
    expect(l1.denied).toContain('Edit');
    // Level 1 has no shell: every command is denied, those below included.
    expect(l1.denied).toContain('Bash');
    for (const level of [2, 3, 4, 5] as const) {
      const denied = claudeToolPolicy(level).denied;
      // Audit F-12: the commands that discard work most directly are denied at every level with a shell.
      for (const cmd of ['git push --force', 'git restore', 'git checkout --', 'git stash drop', 'git branch -D', 'git worktree remove', 'Remove-Item', 'rd /s']) {
        expect(denied, `${cmd} at L${level}`).toContain(`Bash(${cmd}:*)`);
      }
    }
    expect(claudeToolPolicy(2).denied).toContain('Bash(git push:*)');
    expect(claudeToolPolicy(3).denied).not.toContain('Bash(git push:*)');
  });

  /** Claude Code's `Bash(prefix:*)`: the command is the prefix, or starts with it and a space. */
  const deniedBy = (rules: string[], command: string) =>
    rules.some((rule) => {
      const prefix = /^Bash\((.*):\*\)$/.exec(rule)?.[1];
      return prefix !== undefined && (command === prefix || command.startsWith(`${prefix} `));
    });

  it('denies a native push to a release or production branch and a pull-request merge from Level 3 (SEC-1)', () => {
    const releases = [
      { remote: 'upstream', branch: 'site' },
      { remote: 'origin', branch: 'www' },
    ];
    for (const level of [3, 4, 5] as const) {
      const denied = claudeToolPolicy(level, releases).denied;
      expect(denied, `L${level}`).toContain('Bash(gh pr merge:*)');
      expect(denied).not.toContain('Bash(git push:*)');
      for (const command of [
        'git push upstream site',
        'git push -u upstream site',
        'git push --set-upstream upstream HEAD:site',
        'git push origin www',
        'git push origin main',
        'git push -u origin main',
        'git push --set-upstream origin main',
        'git push origin HEAD:main',
        'git push -u origin HEAD:master',
        'gh pr merge 12 --squash',
      ]) {
        expect(deniedBy(denied, command), `${command} at L${level}`).toBe(true);
      }
    }
    // Without a release setting the production-named branches are still denied on origin.
    expect(deniedBy(claudeToolPolicy(3).denied, 'git push origin main')).toBe(true);
    expect(deniedBy(claudeToolPolicy(3).denied, 'git push -u origin HEAD:release')).toBe(true);
    // Level 2 already denies every push and merge.
    expect(claudeToolPolicy(2, releases).denied).toEqual(expect.arrayContaining(['Bash(git push:*)', 'Bash(gh pr merge:*)']));
  });

  it('leaves pushes of other branches to a Level 3 agent', () => {
    const denied = claudeToolPolicy(3, [{ remote: 'origin', branch: 'site' }]).denied;
    for (const command of ['git push origin feature/login', 'git push -u origin acc/task-12', 'git push origin HEAD:feature/login', 'git push origin main-fixes', 'git push origin product-page', 'git push upstream site', 'git push origin sites']) {
      expect(deniedBy(denied, command), command).toBe(false);
    }
  });

  it("denies the Control Center's own files and port natively, and nothing else of the data folder (SEC-3)", () => {
    const dataDir = process.platform === 'win32' ? String.raw`C:\Users\op\AppData\Local\AIDevControlCenter` : '/home/op/.local/share/ai-control-center';
    const data = process.platform === 'win32' ? '//c/Users/op/AppData/Local/AIDevControlCenter' : '//home/op/.local/share/ai-control-center';
    const plugins = path.join(dataDir, 'learning', 'plugins');
    expect(rulePath(dataDir)).toBe(data);
    const cc = { dataDir, port: 4399, readOnly: [plugins] };
    const denied = claudeToolPolicy(2, undefined, { controlCenter: cc }).denied;
    for (const file of ['auth-token', '*.db*', 'credential-key*', 'privileged-key*']) expect(denied).toContain(`Read(${data}/${file})`);
    // One Edit rule covers every file at the data folder's top; the learned plugins below it are read-only.
    expect(denied).toEqual(expect.arrayContaining([`Edit(${data}/*)`, 'Bash(*auth-token*)', 'Bash(*127.0.0.1:4399*)', 'Bash(*localhost:4399*)', `Edit(${data}/learning/plugins/**)`]));
    expect(denied.some((r) => r === `Edit(${data}/**)`)).toBe(false);
    // Settings files through which the hooks could be switched off cannot be edited.
    expect(denied).toEqual(expect.arrayContaining(['Edit(**/.claude/settings*.json)', 'Write(**/.claude/settings*.json)', 'Edit(~/.claude/settings*.json)']));
    // The rest of the data folder (learned skills, attachments) stays readable, and nothing names the work root.
    expect(denied.filter((r) => r.startsWith('Read(')).every((r) => /\/(auth-token|\*\.db\*|credential-key\*|privileged-key\*)\)$/.test(r))).toBe(true);
    expect(denied.some((r) => r === `Read(${data}/**)` || r === `Read(${data})`)).toBe(false);
    // Level 1 reads, so it gets the read rules; its shell and edits are gone already.
    const one = claudeToolPolicy(1, undefined, { controlCenter: cc }).denied;
    expect(one).toEqual(expect.arrayContaining(['Bash', 'Edit', `Read(${data}/auth-token)`]));
    expect(one.some((r) => r.startsWith('Bash(') || r.startsWith('Edit('))).toBe(false);
    // Without the port known, no port rules; the token's name is denied regardless.
    const noPort = claudeToolPolicy(2, undefined, { controlCenter: { dataDir, port: null } }).denied;
    expect(noPort.some((r) => r.includes('127.0.0.1:'))).toBe(false);
    expect(claudeToolPolicy(2).denied).toContain('Bash(*auth-token*)');
  });

  it("makes the shell check's own folder read-only for the run it guards (SEC-3)", () => {
    const script = path.join(os.tmpdir(), 'acc-checkout', 'apps', 'orchestrator', 'dist', 'acc-shell-guard.mjs');
    const rule = `Edit(${rulePath(path.dirname(script))}/**)`;
    const hooked = { command: process.execPath, args: [script], env: {} };
    for (const level of [2, 3, 4, 5] as const) expect(claudeToolPolicy(level, undefined, { guard: hooked }).denied, `L${level}`).toContain(rule);
    // Without a shell there is no hook to protect; Level 1 has neither.
    expect(claudeToolPolicy(3, undefined, { shell: false, guard: hooked }).denied).not.toContain(rule);
    expect(claudeToolPolicy(1, undefined, { guard: hooked }).denied).not.toContain(rule);
  });

  it('passes the rule on its hook folder to the CLI when the run is hooked', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-claude-'));
    const argsFile = path.join(cwd, 'args.json');
    await (await new ClaudeCodeAdapter().execute(input({ cwd, permissionLevel: 2, shellGuard: guard, env: { FAKE_ARGS_FILE: argsFile } }))).done;
    const args = (JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] }).args;
    expect(args[args.indexOf('--disallowedTools') + 1]!.split(',')).toContain(`Edit(${rulePath(path.dirname(guard.args[0]!))}/**)`);
  });

  it('takes Bash and its rules away, and only those, when the shell is off', () => {
    const cc = { dataDir: os.tmpdir(), port: 4399 };
    const off = claudeToolPolicy(3, undefined, { shell: false, controlCenter: cc });
    expect(off.tools).not.toContain('Bash');
    expect(off.allowed).not.toContain('Bash');
    expect(off.denied).toContain('Bash');
    expect(off.denied.some((r) => r.startsWith('Bash('))).toBe(false);
    expect(off.tools).toEqual(expect.arrayContaining(['Edit', 'Write', 'Read']));
    expect(off.denied).toContain(`Read(${rulePath(os.tmpdir())}/auth-token)`);
  });

  it('keeps the rules short enough for cmd.exe, which runs claude.cmd on Windows (8191 characters a line)', () => {
    // cross-spawn quotes each argument and escapes cmd.exe's metacharacters with `^`.
    const cmdLine = (args: string[]) => args.map((a) => `"${a}"`.replace(/([()\][%!^"`<>&|;, *?])/g, '^$1')).join(' ').length;
    const releases = ['upstream', 'deploy', 'pages', 'docs', 'www'].map((remote, i) => ({ remote, branch: `release-${i}` }));
    // A long profile path, with the learned plugins as a read-only folder (SEC-3).
    const dataDir = String.raw`C:\Users\a-rather-long-user-name\AppData\Local\AIDevControlCenter`;
    const hooked = { command: String.raw`C:\Program Files\nodejs\node.exe`, args: [String.raw`C:\Users\a-rather-long-user-name\AI-Development-Control-Center\apps\orchestrator\dist\acc-shell-guard.mjs`], env: {} };
    for (const level of [3, 4, 5] as const) {
      const policy = claudeToolPolicy(level, releases, { controlCenter: { dataDir, port: 43170, readOnly: [path.join(dataDir, 'learning', 'plugins')] }, guard: hooked });
      const hook = shellGuardSettings(hooked);
      const args = ['--tools', policy.tools.join(','), '--allowedTools', [...policy.allowed, 'mcp__acc'].join(','), '--disallowedTools', policy.denied.join(','), '--settings', hook];
      // Five releases on five remotes and the shell guard leave room for the executable, the MCP config and plugin folders.
      expect(cmdLine(args), `L${level}`).toBeLessThan(5_600);
      expect(new Set(policy.denied).size).toBe(policy.denied.length);
    }
  });

  it("writes cmd.exe's operators in the hook settings as JSON escapes, which read back the same", () => {
    const hooked = { command: String.raw`C:\Tools & More\node.exe`, args: [String.raw`C:\a<b>^c\acc-shell-guard.mjs`], env: {} };
    const settings = shellGuardSettings(hooked);
    expect(settings).not.toMatch(/[|&<>^]/);
    const parsed = JSON.parse(settings) as { hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } };
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0]!.matcher).toBe('Bash|Read|Grep|Glob');
    expect(parsed.hooks.PreToolUse[0]!.hooks[0]!.command).toBe('"C:/Tools & More/node.exe" "C:/a<b>^c/acc-shell-guard.mjs"');
  });

  it('passes the release branch denial to the CLI', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-claude-'));
    const argsFile = path.join(cwd, 'args.json');
    await (await new ClaudeCodeAdapter().execute(input({ cwd, permissionLevel: 3, shellGuard: guard, releaseBranches: [{ remote: 'origin', branch: 'site' }], env: { FAKE_ARGS_FILE: argsFile } }))).done;
    const args = (JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] }).args;
    expect(args[args.indexOf('--disallowedTools') + 1]!.split(',')).toEqual(expect.arrayContaining(['Bash(git push origin site:*)', 'Bash(git push -u origin HEAD:site:*)', 'Bash(git push origin main:*)', 'Bash(gh pr merge:*)']));
  });

  it("passes the Control Center's own rules to the CLI from the runtime options", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'acc-claude-'));
    const argsFile = path.join(cwd, 'args.json');
    const dataDir = path.join(cwd, 'data');
    await (await new ClaudeCodeAdapter().execute(input({ cwd, permissionLevel: 2, shellGuard: guard, controlCenter: { dataDir, port: 4399 }, env: { FAKE_ARGS_FILE: argsFile } }))).done;
    const args = (JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[] }).args;
    const tokenRule = `Read(${rulePath(dataDir)}/auth-token)`;
    const denied = args[args.indexOf('--disallowedTools') + 1]!.split(',');
    expect(denied).toContain('Bash(*127.0.0.1:4399*)');
    // With the precheck hook, the token's Read rule asks instead of denying: the CLI weighs a deny rule
    // before the hook (no Control Center reason or row), and `--permission-prompts none` refuses an ask.
    expect(denied).not.toContain(tokenRule);
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!) as { permissions?: { ask?: string[] } };
    expect(settings.permissions?.ask).toContain(tokenRule);
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
  });

  it('keeps the data folder Read rules as deny rules where no precheck hook runs', () => {
    const cc = { dataDir: path.join(os.tmpdir(), 'acc-data'), port: 4399 };
    const tokenRule = `Read(${rulePath(cc.dataDir)}/auth-token)`;
    // Level 1 (no hooks at all) and a Level 2 run without its shell guard.
    for (const policy of [claudeToolPolicy(1, undefined, { controlCenter: cc }), claudeToolPolicy(2, undefined, { shell: false, controlCenter: cc })]) {
      expect(policy.denied).toContain(tokenRule);
      expect(policy.asked).toEqual([]);
    }
    const guarded = claudeToolPolicy(2, undefined, { controlCenter: cc, guard });
    expect(guarded.denied).not.toContain(tokenRule);
    expect(guarded.asked).toContain(tokenRule);
  });

  it('allows skills at every level inside a closed tool set', () => {
    for (const level of [1, 2, 3, 4, 5] as const) {
      const policy = claudeToolPolicy(level);
      expect(policy.allowed).toContain('Skill');
      expect(policy.tools).toEqual(expect.arrayContaining(['Skill', 'ToolSearch', 'Read']));
      expect(policy.tools.includes('Bash')).toBe(level >= 2);
      // A skill's allowed-tools can pre-approve any tool that exists, so these must not exist.
      for (const tool of ['WebFetch', 'WebSearch', 'Agent', 'Task', 'PowerShell']) expect(policy.tools).not.toContain(tool);
    }
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(claudeToolPolicy(1).tools).not.toContain(tool);
      expect(claudeToolPolicy(2).tools).toContain(tool);
    }
  });
});
