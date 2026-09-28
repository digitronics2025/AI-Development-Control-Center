import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentExecutionInput } from '@acc/agent-sdk';
import type { AgentCapabilities, PermissionLevel } from '@acc/shared';
import { adapterConformance, runConformanceCheck, type ConformanceCheckId, type ConformanceTarget } from '@acc/agent-sdk/test-kit';
import { CodexAdapter } from '../src/index.js';

const target: ConformanceTarget = {
  name: 'Codex',
  makeAdapter: () => new CodexAdapter(),
  fakeCli: {
    executable: path.resolve(import.meta.dirname, '../../../tests/fixtures', process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex'),
    scenarios: {
      apiKeyLogin: { FAKE_CODEX_AUTH: 'apikey' },
      usageLimit: { FAKE_CODEX_SCENARIO: 'usage' },
      authFailure: { FAKE_CODEX_SCENARIO: 'auth' },
      modelUnavailable: { FAKE_CODEX_SCENARIO: 'model' },
      hang: { FAKE_CODEX_SCENARIO: 'hang' },
      personalMcp: {
        FAKE_CODEX_MCP_LIST: JSON.stringify([
          { name: 'playwright', enabled: true, transport: { type: 'stdio', command: 'npx' } },
          { name: 'tiktok-ads', enabled: true, transport: { type: 'streamable_http', url: 'https://example.com/mcp' } },
        ]),
        FAKE_CODEX_PLUGIN_MCP: JSON.stringify(['cloudflare-api']),
      },
    },
  },
};

adapterConformance(target);

/** Each variant breaks what one check guards; the kit must say so in that check's words. */
const broken: Array<[ConformanceCheckId, RegExp, () => CodexAdapter]> = [
  [
    'promptOnStdin',
    /prompt is in the CLI's arguments/,
    () =>
      new (class extends CodexAdapter {
        protected override async buildArgs(input: AgentExecutionInput): Promise<string[]> {
          return [...(await super.buildArgs(input)), input.prompt];
        }
      })(),
  ],
  [
    'strictMcp',
    /with the Control Center bridge loads MCP servers \["acc","cloudflare-api"\]/,
    () =>
      new (class extends CodexAdapter {
        // Forgets that account plugins bring their own servers.
        protected override async buildArgs(input: AgentExecutionInput): Promise<string[]> {
          const args = await super.buildArgs(input);
          const at = args.findIndex((arg, i) => arg === '--disable' && args[i + 1] === 'plugins');
          return [...args.slice(0, at), ...args.slice(at + 2)];
        }
      })(),
  ],
  [
    'levelOneReadOnly',
    /a Level 1 run \(user config off\) can change files/,
    () =>
      new (class extends CodexAdapter {
        protected override async buildArgs(input: AgentExecutionInput): Promise<string[]> {
          return super.buildArgs({ ...input, permissionLevel: 2 });
        }
      })(),
  ],
  [
    'declaredCapabilities',
    /the permission ceiling is 6, not one of Levels 1–5/,
    () =>
      new (class extends CodexAdapter {
        // A ceiling above every level would let the launch refusal wave through anything.
        override async getCapabilities(): Promise<AgentCapabilities> {
          return { ...(await super.getCapabilities()), maxPermissionLevel: 6 as PermissionLevel };
        }
      })(),
  ],
];

describe('the conformance kit fails a deliberately broken Codex adapter', () => {
  it.each(broken)('%s', async (check, reason, make) => {
    await expect(runConformanceCheck(check, { ...target, makeAdapter: make })).rejects.toThrow(reason);
  }, 90_000);
});
