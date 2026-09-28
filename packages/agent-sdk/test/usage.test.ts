import { describe, expect, it } from 'vitest';
import { capacityFromFailure, resetFromFailure } from '../src/index.js';

/** Reset times stated in failure text (docs/systems/agents-codex.md#usage-limits; the Codex wording is unconfirmed live). */

// 14:30 local time on 28 Sep 2026: every expectation below is built in the same local time zone.
const now = new Date(2026, 8, 28, 14, 30, 0);
const local = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

describe('resetFromFailure', () => {
  it.each([
    ["You've hit your usage limit. Try again at 21:00.", local(2026, 9, 28, 21)],
    ['try again at 9:00 PM.', local(2026, 9, 28, 21)],
    ['try again at 9pm', local(2026, 9, 28, 21)],
    ['try again at 12:15 a.m.', local(2026, 9, 29, 0, 15)],
    // Already past today: the next time the clock shows it.
    ['Try again at 08:05.', local(2026, 9, 29, 8, 5)],
    ['Try again at 14:30.', local(2026, 9, 29, 14, 30)],
    // With a date, as a later day is written.
    ["You've hit your usage limit. Upgrade to Pro, or try again at Sep 29th, 2026 9:00 PM.", local(2026, 9, 29, 21)],
    ['try again at 2 Oct 2026 07:45', local(2026, 10, 2, 7, 45)],
    ['try again at 2026-10-01 21:00', local(2026, 10, 1, 21)],
    // A date with no year that has passed this year is next year's.
    ['try again at Jan 3rd 9:00 AM', local(2027, 1, 3, 9)],
  ])('%s', (text, expected) => {
    expect(resetFromFailure(text, now)).toBe(expected);
  });

  it('reads a UTC or ISO time as that instant', () => {
    expect(resetFromFailure('try again at 2026-09-29T19:00:00Z', now)).toBe('2026-09-29T19:00:00.000Z');
    const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 0));
    const expected = utc.getTime() > now.getTime() ? utc : new Date(utc.getTime() + 86_400_000);
    expect(resetFromFailure('try again at 23:00 UTC', now)).toBe(expected.toISOString());
  });

  it.each([
    ['Try again in 2 hours 5 minutes.', (2 * 60 + 5) * 60_000],
    ['try again in 3 days 1 hour', (3 * 24 + 1) * 3_600_000],
    ['Rate limit reached. Please try again in 20s.', 20_000],
    ['try again in ~5 min', 5 * 60_000],
    ['try again in 1 hour and 30 minutes', 90 * 60_000],
  ])('%s', (text, wait) => {
    expect(resetFromFailure(text, now)).toBe(new Date(now.getTime() + wait).toISOString());
  });

  it.each([
    'Try again later.',
    'try again at noon',
    'try again at 25:00',
    'try again at 13:00 PM',
    'try again at Feb 30th 9:00 AM',
    'try again in 0 minutes',
    'try again in 90 days',
    'Your workspace is out of credits.',
  ])('reads no reset in %s', (text) => {
    expect(resetFromFailure(text, now)).toBeNull();
  });
});

describe('capacityFromFailure', () => {
  it('gives a usage limit the reset its message states, and none when it states none', () => {
    expect(capacityFromFailure("You've hit your usage limit. Try again at 21:00.", now)).toMatchObject({ metric: 'usage_limit', status: 'exhausted', resetsAt: local(2026, 9, 28, 21) });
    expect(capacityFromFailure("You've hit your usage limit.", now)).toMatchObject({ metric: 'usage_limit', resetsAt: null });
  });

  it('never gives credits a reset time: they come back when bought, not by the clock', () => {
    expect(capacityFromFailure('Your workspace is out of credits. Add credits, or try again at 21:00.', now)).toMatchObject({ metric: 'credit', resetsAt: null });
  });

  it('reads nothing from a failure that is not about capacity', () => {
    expect(capacityFromFailure('Something broke; try again at 21:00', now)).toBeNull();
  });
});
