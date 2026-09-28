import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentExecutionHandle, AgentExecutionInput, AgentExecutionResult, AgentHealth, RawAgentResult } from '@acc/agent-sdk';
import { adapterConformance, runConformanceCheck, type ConformanceCheckId, type ConformanceTarget } from '@acc/agent-sdk/test-kit';
import { ClaudeCodeAdapter } from '../src/index.js';

const target: ConformanceTarget = {
  name: 'Claude Code',
  makeAdapter: () => new ClaudeCodeAdapter(),
  fakeCli: {
    executable: path.resolve(import.meta.dirname, '../../../tests/fixtures', process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude'),
    // A subscription login: the init event says the credentials are no API key.
    env: { FAKE_CLAUDE_APIKEY_SOURCE: 'none' },
    scenarios: {
      apiKeyLogin: { FAKE_CLAUDE_AUTH: 'apikey' },
      usageLimit: { FAKE_CLAUDE_SCENARIO: 'usage' },
      authFailure: { FAKE_CLAUDE_SCENARIO: 'auth' },
      modelUnavailable: { FAKE_CLAUDE_SCENARIO: 'model' },
      hang: { FAKE_CLAUDE_SCENARIO: 'hang' },
      personalMcp: { FAKE_CLAUDE_MCP_SERVERS: JSON.stringify(['playwright', 'tiktok-ads']) },
    },
  },
};

adapterConformance(target);

/** Each variant breaks what one check guards; the kit must say so in that check's words. */
const broken: Array<[ConformanceCheckId, RegExp, () => ClaudeCodeAdapter]> = [
  [
    'promptOnStdin',
    /prompt is in the CLI's arguments/,
    () =>
      new (class extends ClaudeCodeAdapter {
        protected override buildArgs(input: AgentExecutionInput): string[] {
          return [...super.buildArgs(input), input.prompt];
        }
      })(),
  ],
  [
    'promptOnStdin',
    /prompt is in the CLI's arguments/,
    () =>
      new (class extends ClaudeCodeAdapter {
        // Only part of it: the session named after the prompt's opening words.
        protected override buildArgs(input: AgentExecutionInput): string[] {
          return [...super.buildArgs(input), '--name', input.prompt.slice(0, 40)];
        }
      })(),
  ],
  [
    'apiBillingBlocked',
    /health is connected/,
    () =>
      new (class extends ClaudeCodeAdapter {
        // Misreads an API-key sign-in as the subscription.
        protected override async probeAuth(executable: string, env: NodeJS.ProcessEnv): Promise<Omit<AgentHealth, 'checkedAt'>> {
          return { ...(await super.probeAuth(executable, env)), billing: 'subscription' };
        }
      })(),
  ],
  [
    'billingEnvStripped',
    /API billing variables reached the CLI in Subscription Only mode: ANTHROPIC_API_KEY$/,
    () =>
      new (class extends ClaudeCodeAdapter {
        // Forwards a key through an environment the base class adds after sanitising.
        override execute(input: AgentExecutionInput): Promise<AgentExecutionHandle> {
          return super.execute({ ...input, shellGuard: { command: process.execPath, args: [], env: { ANTHROPIC_API_KEY: String(input.baseEnv.ANTHROPIC_API_KEY) } } });
        }
      })(),
  ],
  [
    'sessionTokenPrivate',
    /a file the CLI was given holds the session token/,
    () =>
      new (class extends ClaudeCodeAdapter {
        // Writes the session's value into the MCP config instead of naming the variable.
        protected override buildArgs(input: AgentExecutionInput): string[] {
          const args = super.buildArgs(input);
          const file = args[args.indexOf('--mcp-config') + 1]!;
          writeFileSync(file, readFileSync(file, 'utf8').replace(/\$\{(\w+)\}/g, (_m, name: string) => input.toolBridge?.env[name] ?? ''));
          return args;
        }
      })(),
  ],
  [
    'sessionTokenPrivate',
    /a temporary file holds the session token/,
    () =>
      new (class extends ClaudeCodeAdapter {
        // Keeps the session in a temporary folder of its own, named nowhere in the arguments.
        protected override buildArgs(input: AgentExecutionInput): string[] {
          const folder = mkdtempSync(path.join(os.tmpdir(), 'acc-conformance-leak-'));
          writeFileSync(path.join(folder, 'session.json'), JSON.stringify({ session: input.toolBridge?.env.ACC_TOOL_SESSION }));
          return super.buildArgs(input);
        }
      })(),
  ],
  [
    'sessionTokenPrivate',
    /a temporary file holds the session token/,
    () =>
      new (class extends ClaudeCodeAdapter {
        // The same, removed when the run ends: it was on disk for as long as the run was on.
        protected override buildArgs(input: AgentExecutionInput): string[] {
          const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'acc-conformance-leak-')), 'session.json');
          writeFileSync(file, JSON.stringify({ session: input.toolBridge?.env.ACC_TOOL_SESSION }));
          const args = super.buildArgs(input);
          this.executionFiles.set(input.executionId, [...(this.executionFiles.get(input.executionId) ?? []), file]);
          return args;
        }
      })(),
  ],
  [
    'strictMcp',
    /with the Control Center bridge loads MCP servers \["acc","playwright","tiktok-ads"\]/,
    () =>
      new (class extends ClaudeCodeAdapter {
        protected override buildArgs(input: AgentExecutionInput): string[] {
          return super.buildArgs(input).filter((arg) => arg !== '--strict-mcp-config');
        }
      })(),
  ],
  [
    'strictMcp',
    /with the Control Center bridge loads MCP servers \["acc","playwright"\]/,
    () =>
      new (class extends ClaudeCodeAdapter {
        // A second --mcp-config beside the Control Center's: the real CLI loads the servers of both.
        protected override buildArgs(input: AgentExecutionInput): string[] {
          const args = super.buildArgs(input);
          return input.toolBridge ? [...args, '--mcp-config', JSON.stringify({ mcpServers: { playwright: { type: 'stdio', command: 'npx' } } })] : args;
        }
      })(),
  ],
  [
    'levelOneReadOnly',
    /a Level 1 run \(user config off\) can change files/,
    () =>
      new (class extends ClaudeCodeAdapter {
        protected override buildArgs(input: AgentExecutionInput): string[] {
          return super.buildArgs({ ...input, permissionLevel: 2 });
        }
      })(),
  ],
  [
    'levelOneReadOnly',
    /a Level 1 run \(user config off\) can change files/,
    () =>
      new (class extends ClaudeCodeAdapter {
        // A second --tools: the real CLI adds its tools to the closed set, and PowerShell is in no deny list.
        protected override buildArgs(input: AgentExecutionInput): string[] {
          const args = super.buildArgs(input);
          return input.permissionLevel <= 1 ? [...args, '--tools', 'PowerShell'] : args;
        }
      })(),
  ],
  [
    'levelOneReadOnly',
    /a Level 1 run \(user config off\) can change files/,
    () =>
      new (class extends ClaudeCodeAdapter {
        // `--tools=default`: every built-in tool.
        protected override buildArgs(input: AgentExecutionInput): string[] {
          const args = super.buildArgs(input);
          return input.permissionLevel <= 1 ? [...args, '--tools=default'] : args;
        }
      })(),
  ],
  [
    'failureClasses',
    /usageLimit ended failed PROCESS_CRASH, not failed USAGE_LIMIT/,
    () =>
      new (class extends ClaudeCodeAdapter {
        override async parseResult(raw: RawAgentResult): Promise<AgentExecutionResult> {
          const result = await super.parseResult(raw);
          return result.errorClass ? { ...result, errorClass: 'PROCESS_CRASH' } : result;
        }
      })(),
  ],
  [
    'usageNullNotZero',
    /a run that reported no usage says .*"inputTokens":0/,
    () =>
      new (class extends ClaudeCodeAdapter {
        override async parseResult(raw: RawAgentResult): Promise<AgentExecutionResult> {
          const result = await super.parseResult(raw);
          const zero = { model: 'unknown', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 0, reportedCostUsd: 0 };
          return { ...result, usage: result.usage ?? { providerRequestId: null, resolvedModel: null, lines: [zero], turns: 0, apiDurationMs: 0 } };
        }
      })(),
  ],
  [
    'declaredCapabilities',
    /it declares pluginDirs, but the CLI was not given the plugin folder/,
    () =>
      new (class extends ClaudeCodeAdapter {
        // Still says it loads plugin folders, so prompts would promise skills the run never has.
        protected override buildArgs(input: AgentExecutionInput): string[] {
          return super.buildArgs({ ...input, pluginDirs: [] });
        }
      })(),
  ],
];

describe('the conformance kit fails a deliberately broken Claude Code adapter', () => {
  it.each(broken)('%s', async (check, reason, make) => {
    await expect(runConformanceCheck(check, { ...target, makeAdapter: make })).rejects.toThrow(reason);
  }, 90_000);

  it('sessionTokenPrivate, when the token goes to a temporary folder every run reuses', async () => {
    // A home of the agent's own under the temporary folder: an earlier check's run has already made it.
    const reuses = () =>
      new (class extends ClaudeCodeAdapter {
        protected override buildArgs(input: AgentExecutionInput): string[] {
          const home = path.join(os.tmpdir(), `acc-conformance-fixed-home-${process.pid}`);
          mkdirSync(home, { recursive: true });
          writeFileSync(path.join(home, 'session.json'), JSON.stringify({ session: input.toolBridge?.env.ACC_TOOL_SESSION }));
          return super.buildArgs(input);
        }
      })();
    const fixed = { ...target, makeAdapter: reuses };
    try {
      await runConformanceCheck('promptOnStdin', fixed);
      await expect(runConformanceCheck('sessionTokenPrivate', fixed)).rejects.toThrow(/a temporary file holds the session token/);
    } finally {
      rmSync(path.join(os.tmpdir(), `acc-conformance-fixed-home-${process.pid}`), { recursive: true, force: true });
    }
  }, 90_000);

  it('sessionTokenPrivate, when the token overwrites a temporary file that was already there', async () => {
    // A path the adapter settled before the check moved the temporary folder, written again every run.
    const file = path.join(os.tmpdir(), `acc-conformance-session-${process.pid}.json`);
    writeFileSync(file, '{}');
    const overwrites = () =>
      new (class extends ClaudeCodeAdapter {
        protected override buildArgs(input: AgentExecutionInput): string[] {
          writeFileSync(file, JSON.stringify({ session: input.toolBridge?.env.ACC_TOOL_SESSION }));
          return super.buildArgs(input);
        }
      })();
    try {
      await expect(runConformanceCheck('sessionTokenPrivate', { ...target, makeAdapter: overwrites })).rejects.toThrow(/a temporary file holds the session token/);
    } finally {
      rmSync(file, { force: true });
    }
  }, 90_000);
});
