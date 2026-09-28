import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentExecutionInput } from '@acc/agent-sdk';
import { CodexAdapter, codexConfiguredModel, codexUsage } from '../src/index.js';

const fake = path.resolve(import.meta.dirname, '../../../tests/fixtures', process.platform === 'win32' ? 'fake-codex.cmd' : 'fake-codex');

function input(env: NodeJS.ProcessEnv = {}, model = 'gpt-5.5'): AgentExecutionInput {
  return {
    executionId: `exec-${Math.random().toString(36).slice(2)}`,
    cwd: os.tmpdir(),
    prompt: 'Reply PONG',
    model,
    effort: 'default',
    permissionLevel: 1,
    timeoutMs: 20_000,
    billingMode: 'subscription',
    baseEnv: { ...process.env, ...env },
    executablePath: fake,
  };
}

describe('Codex usage parsing', () => {
  it('separates cached input from uncached input and keeps unreported dimensions null', () => {
    const usage = codexUsage([{ input: 1200, cached: 1000, output: 80, reasoning: 30 }], 't1', 'gpt-5.5')!;
    expect(usage.lines).toEqual([
      { model: 'gpt-5.5', inputTokens: 200, outputTokens: 80, cacheReadTokens: 1000, cacheWriteTokens: null, cacheWrite1hTokens: null, reasoningTokens: 30, reportedCostUsd: null },
    ]);
    expect(usage.resolvedModel).toBeNull();
  });

  it('sums several turns and reports nothing when no turn completed', () => {
    const usage = codexUsage(
      [
        { input: 10, cached: null, output: 5, reasoning: null },
        { input: 20, cached: 4, output: 5, reasoning: null },
      ],
      null,
      'default',
    )!;
    expect(usage.lines[0]).toMatchObject({ model: 'default', inputTokens: 26, cacheReadTokens: 4, outputTokens: 10, reasoningTokens: null });
    expect(codexUsage([], null, 'default')).toBeNull();
  });

  it('reports usage through the adapter, with no cost (Codex reports none)', async () => {
    const result = await (await new CodexAdapter().execute(input())).done;
    expect(result.status).toBe('succeeded');
    expect(result.usage?.providerRequestId).toBe('thread-123');
    expect(result.usage?.lines[0]).toMatchObject({ model: 'gpt-5.5', inputTokens: 200, cacheReadTokens: 1000, reportedCostUsd: null });
    expect(result.capacity).toEqual([]);
  });

  it('turns an out-of-credits failure into an exhausted credit reading', async () => {
    const result = await (await new CodexAdapter().execute(input({ FAKE_CODEX_SCENARIO: 'usage' }))).done;
    expect(result.errorClass).toBe('USAGE_LIMIT');
    expect(result.usage).toBeNull();
    expect(result.capacity).toEqual([expect.objectContaining({ metric: 'credit', status: 'exhausted', usedPercent: null })]);
  });

  it('reads the reset time a usage-limit failure states: "try again at 21:00" is the next local 21:00', async () => {
    const before = new Date();
    const result = await (await new CodexAdapter().execute(input({ FAKE_CODEX_SCENARIO: 'limit' }))).done;
    expect(result.errorClass).toBe('USAGE_LIMIT');
    const reading = result.capacity?.find((c) => c.metric === 'usage_limit');
    expect(reading).toMatchObject({ status: 'exhausted', resetsAt: expect.any(String) });
    const reset = new Date(reading!.resetsAt!);
    expect([reset.getHours(), reset.getMinutes()]).toEqual([21, 0]);
    expect(reset.getTime()).toBeGreaterThan(before.getTime());
    expect(reset.getTime() - before.getTime()).toBeLessThanOrEqual(86_400_000);
    // The relative form too.
    const later = await (await new CodexAdapter().execute(input({ FAKE_CODEX_SCENARIO: 'limit', FAKE_CODEX_LIMIT_TEXT: "You've hit your usage limit. Try again in 2 hours 5 minutes." }))).done;
    const wait = Date.parse(later.capacity!.find((c) => c.metric === 'usage_limit')!.resetsAt!) - before.getTime();
    expect(wait).toBeGreaterThanOrEqual(125 * 60_000);
    expect(wait).toBeLessThan(126 * 60_000 + 20_000);
  });
});

describe("Codex's configured model", () => {
  function codexHome(config: string | null): string {
    const home = mkdtempSync(path.join(os.tmpdir(), 'acc-codex-home-'));
    if (config !== null) writeFileSync(path.join(home, 'config.toml'), config);
    return home;
  }

  it.each([
    ['model = "gpt-5.5-codex"\n', 'gpt-5.5-codex'],
    ["# comment\nmodel = 'gpt-5.5' # trailing\n[mcp_servers.x]\nmodel = \"not-this\"\n", 'gpt-5.5'],
    ['model = "gpt-5.5"\nprofile = "deep"\n[profiles.deep]\nmodel = "gpt-6-pro"\n', 'gpt-6-pro'],
    ['model = "gpt-5.5"\nprofile = "a.b"\n[profiles."a.b"]\nmodel = "gpt-6"\n', 'gpt-6'],
    // A selected profile without a model falls back to the top level.
    ['model = "gpt-5.5"\nprofile = "fast"\n[profiles.fast]\nmodel_reasoning_effort = "low"\n', 'gpt-5.5'],
  ])('reads %j as %s', (config, expected) => {
    expect(codexConfiguredModel({ CODEX_HOME: codexHome(config) })).toBe(expected);
  });

  it('is null without the file, the key or a sane name', () => {
    expect(codexConfiguredModel({ CODEX_HOME: codexHome(null) })).toBeNull();
    expect(codexConfiguredModel({ CODEX_HOME: codexHome('[profiles.deep]\nmodel = "gpt-6"\n') })).toBeNull();
    expect(codexConfiguredModel({ CODEX_HOME: codexHome('model = "gpt 5; rm -rf"\n') })).toBeNull();
  });

  it('resolves a run on "default" to it, unless the run ignores the user config or asks for a model', async () => {
    const CODEX_HOME = codexHome('model = "gpt-5.5-codex"\n');
    const resolved = await (await new CodexAdapter().execute(input({ CODEX_HOME }, 'default'))).done;
    expect(resolved.usage).toMatchObject({ resolvedModel: 'gpt-5.5-codex', lines: [expect.objectContaining({ model: 'gpt-5.5-codex', inputTokens: 200 })] });
    const ignored = await (await new CodexAdapter().execute({ ...input({ CODEX_HOME }, 'default'), loadUserConfig: false })).done;
    expect(ignored.usage).toMatchObject({ resolvedModel: null, lines: [expect.objectContaining({ model: 'default' })] });
    const asked = await (await new CodexAdapter().execute(input({ CODEX_HOME }, 'gpt-5.5'))).done;
    expect(asked.usage).toMatchObject({ resolvedModel: null, lines: [expect.objectContaining({ model: 'gpt-5.5' })] });
    expect(codexUsage([{ input: 1, cached: 0, output: 1, reasoning: null }], null, 'default', 'gpt-6')).toMatchObject({ resolvedModel: 'gpt-6', lines: [expect.objectContaining({ model: 'gpt-6' })] });
  });
});
