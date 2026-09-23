import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CapacityCollector, type AgentExecutionInput } from '@acc/agent-sdk';
import { ClaudeCodeAdapter, claudeCapacity, claudeUsage } from '../src/index.js';

const fixtures = path.resolve(import.meta.dirname, '../../../tests/fixtures');
const fake = path.join(fixtures, process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude');
/** Events captured from a real Claude Code 2.1.280 run on the operator's machine (2026-09-23). */
const [rateLimitEvent, resultEvent] = readFileSync(path.join(fixtures, 'claude-2.1.280-usage.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as Record<string, any>);

function input(env: NodeJS.ProcessEnv = {}): AgentExecutionInput {
  return {
    executionId: `exec-${Math.random().toString(36).slice(2)}`,
    cwd: os.tmpdir(),
    prompt: 'Reply PONG',
    model: 'haiku',
    effort: 'default',
    permissionLevel: 1,
    timeoutMs: 20_000,
    billingMode: 'subscription',
    baseEnv: { ...process.env, ...env },
    executablePath: fake,
  };
}

describe('Claude Code usage parsing (real 2.1.280 output)', () => {
  it('takes cumulative per-model usage and the reported cost from the result event', () => {
    const usage = claudeUsage(resultEvent!, 'sess', 'claude-haiku-4-5-20251001')!;
    expect(usage).toMatchObject({ providerRequestId: 'sess', resolvedModel: 'claude-haiku-4-5-20251001', turns: 1, apiDurationMs: 2021 });
    expect(usage.lines).toEqual([
      {
        model: 'claude-haiku-4-5',
        // modelUsage is cumulative over the run; the top-level usage (9 input) covers the last turn only.
        inputTokens: 910,
        outputTokens: 59,
        cacheReadTokens: 26009,
        cacheWriteTokens: 14666,
        cacheWrite1hTokens: 14666,
        reasoningTokens: 38,
        reportedCostUsd: 0.0331379,
      },
    ]);
  });

  it('leaves the one-hour share unknown when several models ran', () => {
    const event = structuredClone(resultEvent!);
    event.modelUsage['claude-sonnet-5'] = { inputTokens: 5, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 100, costUSD: 0.001 };
    const usage = claudeUsage(event, null, null)!;
    expect(usage.lines).toHaveLength(2);
    expect(usage.lines.every((l) => l.cacheWrite1hTokens === null)).toBe(true);
  });

  it('keeps missing values null rather than zero', () => {
    const usage = claudeUsage({ modelUsage: { m: { inputTokens: 3, outputTokens: 'x', costUSD: -1 } } }, null, null)!;
    expect(usage.lines[0]).toMatchObject({ inputTokens: 3, outputTokens: null, cacheReadTokens: null, reportedCostUsd: null });
    expect(claudeUsage({}, null, null)).toBeNull();
  });

  it('reads subscription windows and extra-usage state from the rate-limit event', () => {
    const collector = new CapacityCollector();
    claudeCapacity(rateLimitEvent!.rate_limit_info, collector);
    const byMetric = Object.fromEntries(collector.list().map((c) => [c.metric, c]));
    expect(byMetric['window:five_hour']).toMatchObject({ label: '5-hour window', usedPercent: 8, status: 'ok', resetsAt: new Date(1790184000 * 1000).toISOString() });
    expect(byMetric['window:seven_day']).toMatchObject({ label: 'Weekly window', usedPercent: 46, status: 'ok' });
    expect(byMetric.overage).toMatchObject({ status: 'exhausted', detail: 'Not available: out of credits' });
  });

  it('marks a rejected window as exhausted', () => {
    const collector = new CapacityCollector();
    claudeCapacity({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1790122800 }, collector);
    expect(collector.list()).toEqual([expect.objectContaining({ metric: 'window:five_hour', status: 'exhausted', usedPercent: null })]);
  });

  it('reports usage and capacity through the adapter', async () => {
    const result = await (await new ClaudeCodeAdapter().execute(input())).done;
    expect(result.status).toBe('succeeded');
    expect(result.usage?.lines[0]).toMatchObject({ model: 'claude-haiku-4-5', inputTokens: 910, reportedCostUsd: 0.0331379 });
    expect(result.capacity.map((c) => c.metric).sort()).toEqual(['overage', 'window:five_hour', 'window:seven_day']);
  });

  it('records a usage limit as exhausted capacity even without usage', async () => {
    const result = await (await new ClaudeCodeAdapter().execute(input({ FAKE_CLAUDE_SCENARIO: 'usage' }))).done;
    expect(result.errorClass).toBe('USAGE_LIMIT');
    expect(result.usage).toBeNull();
    expect(result.capacity).toEqual([expect.objectContaining({ metric: 'window:five_hour', status: 'exhausted' })]);
  });
});
