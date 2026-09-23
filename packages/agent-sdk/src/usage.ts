import type { CapacityObservation } from './contract.js';

/**
 * Helpers for normalising provider usage payloads. Provider output is
 * untrusted: anything that is not a finite, non-negative number becomes
 * `null` ("not reported"), never 0.
 */

/** A token count, or null when the value is missing or malformed. */
export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** A cost in dollars, or null when missing or malformed. */
export function dollars(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Sum that stays null only when every part is null. */
export function sumCounts(...values: Array<number | null>): number | null {
  let total: number | null = null;
  for (const v of values) if (v !== null) total = (total ?? 0) + v;
  return total;
}

/** Seconds-since-epoch (as providers send reset times) to ISO, or null. */
export function epochSecondsToIso(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
}

/** Keeps the latest observation per metric; later readings replace earlier ones. */
export class CapacityCollector {
  private readonly byMetric = new Map<string, CapacityObservation>();

  add(observation: Omit<CapacityObservation, 'observedAt'>): void {
    this.byMetric.set(observation.metric, { ...observation, observedAt: new Date().toISOString() });
  }

  has(metric: string): boolean {
    return this.byMetric.has(metric);
  }

  list(): CapacityObservation[] {
    return [...this.byMetric.values()];
  }
}

const OUT_OF_CREDITS = /out of credits|insufficient (?:credits|balance)|add credits/i;
const USAGE_LIMIT = /usage limit|hit your limit|rate limit|too many requests|\b429\b/i;

/**
 * Capacity signal carried by a provider failure message, when it states one
 * plainly ("workspace is out of credits", "you've hit your usage limit").
 */
export function capacityFromFailure(message: string): Omit<CapacityObservation, 'observedAt'> | null {
  const detail = message.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (OUT_OF_CREDITS.test(message)) {
    return { metric: 'credit', label: 'Credit', usedPercent: null, status: 'exhausted', resetsAt: null, detail };
  }
  if (USAGE_LIMIT.test(message)) {
    return { metric: 'usage_limit', label: 'Usage limit', usedPercent: null, status: 'exhausted', resetsAt: null, detail };
  }
  return null;
}
