import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentGuardError, type AgentExecutionInput } from '@acc/agent-sdk';
import { ClaudeCodeAdapter, claudeToolPolicy, lookupWasFree, readInitEvent } from '../src/index.js';

const fixture = path.resolve(import.meta.dirname, '../../../tests/fixtures', process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude');

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
    baseEnv: { ...process.env, ...env },
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

    const user = await argsOf({ permissionLevel: 2, loadUserConfig: true });
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
    const learned = await argsOf({ permissionLevel: 2, pluginDirs: ['C:/data/learning/plugins/global', 'C:/data/learning/plugins/repo-r1'] });
    expect(learned.filter((a) => a === '--plugin-dir')).toHaveLength(2);
    expect(after(learned, '--plugin-dir')).toBe('C:/data/learning/plugins/global');
    expect(learned.at(-1)).toBe('C:/data/learning/plugins/repo-r1');
    expect(after(learned, '--tools')).toBe(claudeToolPolicy(2).tools.join(','));
    expect(user).not.toContain('--plugin-dir');
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
    for (const level of [1, 2, 3, 4, 5] as const) {
      const denied = claudeToolPolicy(level).denied;
      // Audit F-12: the commands that discard work most directly are denied at every level.
      for (const cmd of ['git push --force', 'git restore', 'git checkout --', 'git stash drop', 'git branch -D', 'git worktree remove', 'Remove-Item', 'rd /s']) {
        expect(denied, `${cmd} at L${level}`).toContain(`Bash(${cmd}:*)`);
      }
    }
    expect(claudeToolPolicy(2).denied).toContain('Bash(git push:*)');
    expect(claudeToolPolicy(3).denied).not.toContain('Bash(git push:*)');
  });

  it('allows skills at every level inside a closed tool set', () => {
    for (const level of [1, 2, 3, 4, 5] as const) {
      const policy = claudeToolPolicy(level);
      expect(policy.allowed).toContain('Skill');
      expect(policy.tools).toEqual(expect.arrayContaining(['Skill', 'ToolSearch', 'Read', 'Bash']));
      // A skill's allowed-tools can pre-approve any tool that exists, so these must not exist.
      for (const tool of ['WebFetch', 'WebSearch', 'Agent', 'Task', 'PowerShell']) expect(policy.tools).not.toContain(tool);
    }
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(claudeToolPolicy(1).tools).not.toContain(tool);
      expect(claudeToolPolicy(2).tools).toContain(tool);
    }
  });
});
