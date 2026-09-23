import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentExecutionInput } from '@acc/agent-sdk';
import { CodexAdapter, codexUsage } from '../src/index.js';

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
});
