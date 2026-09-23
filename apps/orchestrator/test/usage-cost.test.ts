import { describe, expect, it } from 'vitest';
import type { AgentUsageLine } from '@acc/agent-sdk';
import { formatUsd, type PricingVersion } from '@acc/shared';
import { calculateLineCost, resolveEventCost, sumTokens, usdToNanos } from '../src/usage/cost.js';

const haiku: PricingVersion = {
  id: 'p-haiku',
  provider: 'anthropic',
  providerModelId: 'claude-haiku-4-5',
  inputNanos: 1000,
  outputNanos: 5000,
  cacheReadNanos: 100,
  cacheWriteNanos: 1250,
  cacheWrite1hNanos: 2000,
  currency: 'USD',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  source: 'test',
  verification: 'verified',
  lastVerifiedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const line = (patch: Partial<AgentUsageLine> = {}): AgentUsageLine => ({
  model: 'claude-haiku-4-5',
  inputTokens: 910,
  outputTokens: 59,
  cacheReadTokens: 26009,
  cacheWriteTokens: 14666,
  cacheWrite1hTokens: 14666,
  reasoningTokens: 38,
  reportedCostUsd: 0.0331379,
  ...patch,
});

describe('cost engine', () => {
  it('reproduces the cost Claude Code reported for a real run, to the nano-dollar', () => {
    const calculated = calculateLineCost(line(), haiku);
    expect(calculated).toBe(usdToNanos(0.0331379));
    expect(calculated).toBe(33_137_900);
  });

  it('prices each dimension separately: input, output, cache reads, 5-minute and 1-hour writes', () => {
    expect(calculateLineCost(line({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 }), haiku)).toBe(1_000_000_000);
    expect(calculateLineCost(line({ inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }), haiku)).toBe(5_000_000_000);
    expect(calculateLineCost(line({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }), haiku)).toBe(100_000_000);
    expect(calculateLineCost(line({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 0 }), haiku)).toBe(1_250_000_000);
    expect(calculateLineCost(line({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 400_000 }), haiku)).toBe(600_000 * 1250 + 400_000 * 2000);
  });

  it('refuses to guess: missing input or output, or an unsplit write at two rates, is unknown', () => {
    expect(calculateLineCost(line({ inputTokens: null }), haiku)).toBeNull();
    expect(calculateLineCost(line({ outputTokens: null }), haiku)).toBeNull();
    expect(calculateLineCost(line({ cacheWrite1hTokens: null }), haiku)).toBeNull();
    // Tokens that would be billed but were not reported.
    expect(calculateLineCost(line({ cacheReadTokens: null }), haiku)).toBeNull();
  });

  it('treats a dimension the price list does not bill (and the provider did not report) as zero', () => {
    const openai = { ...haiku, cacheWriteNanos: null, cacheWrite1hNanos: null, cacheReadNanos: 125 };
    expect(calculateLineCost(line({ inputTokens: 200, outputTokens: 80, cacheReadTokens: 1000, cacheWriteTokens: null, cacheWrite1hTokens: null }), openai)).toBe(200 * 1000 + 80 * 5000 + 1000 * 125);
  });

  it('uses one rate for every write when there is no separate one-hour rate', () => {
    const single = { ...haiku, cacheWrite1hNanos: null };
    expect(calculateLineCost(line({ cacheWrite1hTokens: null }), single)).toBe(910 * 1000 + 59 * 5000 + 26009 * 100 + 14666 * 1250);
  });

  it('prefers provider-reported cost, falls back to calculated, and never turns unknown into zero', () => {
    const provider = resolveEventCost([{ line: line(), providerCostNanos: 33_137_900, calculatedCostNanos: 33_137_900, pricingVersionId: 'p' }]);
    expect(provider).toMatchObject({ costSource: 'PROVIDER', displayCostNanos: 33_137_900, pricingVersionId: 'p' });
    const calculated = resolveEventCost([{ line: line(), providerCostNanos: null, calculatedCostNanos: 500, pricingVersionId: 'p' }]);
    expect(calculated).toMatchObject({ costSource: 'CALCULATED', displayCostNanos: 500 });
    const mixed = resolveEventCost([
      { line: line(), providerCostNanos: 100, calculatedCostNanos: null, pricingVersionId: null },
      { line: line(), providerCostNanos: null, calculatedCostNanos: 50, pricingVersionId: 'p' },
    ]);
    expect(mixed).toMatchObject({ costSource: 'CALCULATED', displayCostNanos: 150, providerCostNanos: null });
    const unknown = resolveEventCost([{ line: line(), providerCostNanos: null, calculatedCostNanos: null, pricingVersionId: null }]);
    expect(unknown).toMatchObject({ costSource: 'UNKNOWN', displayCostNanos: null });
    expect(resolveEventCost([])).toMatchObject({ costSource: 'UNKNOWN', displayCostNanos: null });
  });

  it('sums tokens per dimension without counting reasoning twice', () => {
    expect(sumTokens([line(), line({ inputTokens: 10, cacheWriteTokens: null })])).toEqual({
      input: 920,
      output: 118,
      cacheRead: 52018,
      cacheWrite: 14666,
      reasoning: 76,
      total: 920 + 118 + 52018 + 14666,
    });
    expect(sumTokens([line({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null })]).total).toBeNull();
  });

  it('keeps decimal precision in integer nano-dollars', () => {
    expect(usdToNanos(0.1 + 0.2)).toBe(300_000_000);
    expect(usdToNanos(null)).toBeNull();
    expect(usdToNanos(-1)).toBeNull();
    expect(formatUsd(33_137_900)).toBe('$0.0331');
    expect(formatUsd(null)).toBe('Unknown');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(12)).toBe('<$0.0001');
    expect(formatUsd(12_345_670_000_000)).toBe('$12,345.67');
  });
});
