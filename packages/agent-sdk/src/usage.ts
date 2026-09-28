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

const MINUTE_MS = 60_000;
/** A stated wait longer than this is not a reset time this parser trusts. */
const MAX_WAIT_MS = 62 * 24 * 60 * MINUTE_MS;
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: MINUTE_MS, s: 1_000 };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const RELATIVE = /try again in\s+(?:about\s+|~\s*)?((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b[\s,]*(?:and\s+)?)+)/i;
const ABSOLUTE = /try again at\s+([^\n]{1,60})/i;
const ISO_INSTANT = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/i;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const MONTH_FIRST = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?/i;
const DAY_FIRST = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4})\b)?/i;
const CLOCK_12 = /\b(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*([ap])\.?\s*m\b\.?/i;
const CLOCK_24 = /\b(\d{1,2}):(\d{2})(?::\d{2})?\b/;
const UTC_ZONE = /\b(?:UTC|GMT)\b/i;

/** A local (or UTC) wall-clock time, or null when the fields do not name a real moment. */
function wallClock(year: number, month: number, day: number, hour: number, minute: number, utc: boolean): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const date = utc ? new Date(Date.UTC(year, month, day, hour, minute)) : new Date(year, month, day, hour, minute);
  const [y, mo, d] = utc ? [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()] : [date.getFullYear(), date.getMonth(), date.getDate()];
  return y === year && mo === month && d === day ? date : null;
}

/**
 * When a provider failure message says the limit lifts, as an ISO time, or
 * null when it names none this parser can read. Two forms (docs/systems/agents-codex.md#usage-limits,
 * unconfirmed against a live Codex run):
 *
 * - relative: "try again in 2 hours 5 minutes", "try again in 3 days 1 hour", "try again in 20s";
 * - absolute: "try again at 21:00", "try again at 9:00 PM", "try again at Sep 29th, 2026 9:00 PM",
 *   "try again at 2026-09-29 21:00", or an ISO instant.
 *
 * A clock time with no date is the next time the machine's local clock shows
 * it; a date with no year is this year's, or next year's once it has passed.
 */
export function resetFromFailure(message: string, now: Date = new Date()): string | null {
  const relative = RELATIVE.exec(message);
  if (relative) {
    let wait = 0;
    for (const [, amount, unit] of relative[1]!.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) wait += Number(amount) * (UNIT_MS[(unit ?? '').charAt(0).toLowerCase()] ?? 0);
    return wait > 0 && wait <= MAX_WAIT_MS ? new Date(now.getTime() + Math.round(wait)).toISOString() : null;
  }
  const absolute = ABSOLUTE.exec(message)?.[1];
  if (!absolute) return null;
  const instant = ISO_INSTANT.exec(absolute)?.[1];
  if (instant) {
    const at = Date.parse(instant);
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  }
  // The date first, so its day number is not read as an hour.
  let rest = absolute;
  let date: { year: number | null; month: number; day: number } | null = null;
  const iso = ISO_DATE.exec(rest);
  const named = iso ? null : (MONTH_FIRST.exec(rest) ?? DAY_FIRST.exec(rest));
  if (iso) {
    date = { year: Number(iso[1]), month: Number(iso[2]) - 1, day: Number(iso[3]) };
    rest = rest.replace(iso[0], ' ');
  } else if (named) {
    const monthFirst = /^[a-z]/i.test(named[1]!);
    const month = MONTHS.indexOf((monthFirst ? named[1]! : named[2]!).slice(0, 3).toLowerCase());
    date = { year: named[3] ? Number(named[3]) : null, month, day: Number(monthFirst ? named[2] : named[1]) };
    rest = rest.replace(named[0], ' ');
  }
  let hour: number;
  let minute: number;
  const twelve = CLOCK_12.exec(rest);
  const twentyFour = twelve ? null : CLOCK_24.exec(rest);
  if (twelve) {
    const h = Number(twelve[1]);
    if (h < 1 || h > 12) return null;
    hour = (h % 12) + (twelve[3]!.toLowerCase() === 'p' ? 12 : 0);
    minute = Number(twelve[2] ?? 0);
  } else if (twentyFour) {
    hour = Number(twentyFour[1]);
    minute = Number(twentyFour[2]);
  } else {
    return null;
  }
  const utc = UTC_ZONE.test(rest);
  const year = utc ? now.getUTCFullYear() : now.getFullYear();
  if (date) {
    let at = wallClock(date.year ?? year, date.month, date.day, hour, minute, utc);
    // "Sep 29th" with no year: the next one, never last year's.
    if (at && date.year === null && at.getTime() < now.getTime() - 86_400_000) at = wallClock(year + 1, date.month, date.day, hour, minute, utc);
    return at ? at.toISOString() : null;
  }
  const [month, day] = utc ? [now.getUTCMonth(), now.getUTCDate()] : [now.getMonth(), now.getDate()];
  const today = wallClock(year, month, day, hour, minute, utc);
  if (!today) return null;
  if (today.getTime() > now.getTime()) return today.toISOString();
  // Already past today: the next time the clock shows it (DST-safe: built from the calendar, not +24 h).
  const tomorrow = utc ? new Date(Date.UTC(year, month, day + 1, hour, minute)) : new Date(year, month, day + 1, hour, minute);
  return tomorrow.toISOString();
}

/**
 * Capacity signal carried by a provider failure message, when it states one
 * plainly ("workspace is out of credits", "you've hit your usage limit"). A
 * usage limit carries its reset time when the message says it
 * (`resetFromFailure`); credits never reset by themselves.
 */
export function capacityFromFailure(message: string, now: Date = new Date()): Omit<CapacityObservation, 'observedAt'> | null {
  const detail = message.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (OUT_OF_CREDITS.test(message)) {
    return { metric: 'credit', label: 'Credit', usedPercent: null, status: 'exhausted', resetsAt: null, detail };
  }
  if (USAGE_LIMIT.test(message)) {
    // Provider text is untrusted and may be long: the reset is read from its start only.
    return { metric: 'usage_limit', label: 'Usage limit', usedPercent: null, status: 'exhausted', resetsAt: resetFromFailure(message.slice(0, 2_000), now), detail };
  }
  return null;
}
