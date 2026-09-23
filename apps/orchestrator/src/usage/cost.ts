import type { AgentUsageLine } from '@acc/agent-sdk';
import { NANOS_PER_USD, type CostSource, type PricingVersion, type UsageTokens } from '@acc/shared';

/**
 * The cost engine (docs/systems/usage.md#cost). Pure functions over integer
 * nano-dollars: a price is whole nano-dollars per token, so a calculated
 * cost is exact. Anything that cannot be priced exactly is `null` — a cost
 * is never guessed and never assumed to be zero.
 */

/** Dollars (as providers report them) to integer nano-dollars. */
export function usdToNanos(usd: number | null): number | null {
  return usd === null || !Number.isFinite(usd) || usd < 0 ? null : Math.round(usd * NANOS_PER_USD);
}

/** Price per million tokens (as published) to nano-dollars per token. */
export function perMillionToNanos(perMillion: number): number {
  return Math.round(perMillion * 1000);
}

/**
 * One dimension's cost. A known count at a known price is exact; zero tokens
 * cost nothing whatever the price; a dimension the price list does not bill
 * (`null` price) and the provider did not report adds nothing; any other
 * combination (tokens that would be billed but were not reported, or tokens
 * with no price) makes the whole cost unknown.
 */
function dimension(count: number | null, price: number | null): number | null {
  if (count === 0) return 0;
  if (count === null) return price === null ? 0 : null;
  return price === null ? null : count * price;
}

/** Exact cost of one usage line at one price version, or null when it cannot be exact. */
export function calculateLineCost(line: AgentUsageLine, price: PricingVersion): number | null {
  if (line.inputTokens === null || line.outputTokens === null) return null;
  const parts = [line.inputTokens * price.inputNanos, line.outputTokens * price.outputNanos, dimension(line.cacheReadTokens, price.cacheReadNanos)];
  const writes = line.cacheWriteTokens;
  const fiveMinute = price.cacheWriteNanos;
  // Without a separate one-hour rate every write is billed at the one rate.
  const oneHour = price.cacheWrite1hNanos ?? fiveMinute;
  if (!writes) parts.push(dimension(writes, fiveMinute ?? oneHour));
  else if (fiveMinute === oneHour) parts.push(dimension(writes, fiveMinute));
  else if (line.cacheWrite1hTokens === null) parts.push(null); // two rates, split not reported: not exact
  else parts.push(dimension(writes - line.cacheWrite1hTokens, fiveMinute), dimension(line.cacheWrite1hTokens, oneHour));
  let total = 0;
  for (const part of parts) {
    if (part === null) return null;
    total += part;
  }
  return total;
}

export interface CostedLine {
  line: AgentUsageLine;
  providerCostNanos: number | null;
  calculatedCostNanos: number | null;
  pricingVersionId: string | null;
}

export interface EventCost {
  providerCostNanos: number | null;
  calculatedCostNanos: number | null;
  displayCostNanos: number | null;
  costSource: CostSource;
  pricingVersionId: string | null;
}

function sumAll(values: Array<number | null>): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

/**
 * The cost of an attempt from its lines: provider-reported cost when every
 * line has it (PROVIDER), otherwise each line's provider cost or calculated
 * cost (CALCULATED), otherwise Unknown. An attempt with no usage lines has
 * an unknown cost — it may still have been billed.
 */
export function resolveEventCost(lines: CostedLine[]): EventCost {
  if (!lines.length) {
    return { providerCostNanos: null, calculatedCostNanos: null, displayCostNanos: null, costSource: 'UNKNOWN', pricingVersionId: null };
  }
  const providerCostNanos = sumAll(lines.map((l) => l.providerCostNanos));
  const calculatedCostNanos = sumAll(lines.map((l) => l.calculatedCostNanos));
  const versions = [...new Set(lines.map((l) => l.pricingVersionId).filter((v): v is string => v !== null))];
  const pricingVersionId = versions.length === 1 ? versions[0]! : null;
  if (providerCostNanos !== null) return { providerCostNanos, calculatedCostNanos, displayCostNanos: providerCostNanos, costSource: 'PROVIDER', pricingVersionId };
  const display = sumAll(lines.map((l) => l.providerCostNanos ?? l.calculatedCostNanos));
  return display === null
    ? { providerCostNanos: null, calculatedCostNanos, displayCostNanos: null, costSource: 'UNKNOWN', pricingVersionId }
    : { providerCostNanos: null, calculatedCostNanos, displayCostNanos: display, costSource: 'CALCULATED', pricingVersionId };
}

function sumCounts(values: Array<number | null>): number | null {
  let total: number | null = null;
  for (const v of values) if (v !== null) total = (total ?? 0) + v;
  return total;
}

/** Event-level tokens: per-dimension sums across lines; `total` excludes reasoning (it is inside output). */
export function sumTokens(lines: AgentUsageLine[]): UsageTokens {
  const input = sumCounts(lines.map((l) => l.inputTokens));
  const output = sumCounts(lines.map((l) => l.outputTokens));
  const cacheRead = sumCounts(lines.map((l) => l.cacheReadTokens));
  const cacheWrite = sumCounts(lines.map((l) => l.cacheWriteTokens));
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: sumCounts(lines.map((l) => l.reasoningTokens)),
    total: sumCounts([input, output, cacheRead, cacheWrite]),
  };
}
