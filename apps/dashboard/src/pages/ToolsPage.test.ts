import { describe, expect, it } from 'vitest';
import { upcomingRenewal } from './ToolsPage';

describe('upcomingRenewal', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');

  it('names the renewal while the access token is still valid', () => {
    expect(upcomingRenewal('2026-09-27T12:40:00.000Z', now)).toBe('2026-09-27T12:40:00.000Z');
  });

  it('names nothing once the token has expired: an idle server renews only on its next use', () => {
    // A one-hour token saved three hours ago read "access renews 2 hours ago".
    expect(upcomingRenewal('2026-09-27T10:00:00.000Z', now)).toBeNull();
    expect(upcomingRenewal('2026-09-27T12:00:00.000Z', now)).toBeNull();
    expect(upcomingRenewal(null, now)).toBeNull();
    expect(upcomingRenewal('not a date', now)).toBeNull();
  });
});
