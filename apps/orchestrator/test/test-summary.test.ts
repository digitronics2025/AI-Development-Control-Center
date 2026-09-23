import { describe, expect, it } from 'vitest';
import { testFailureSummary, testPassSummary } from '../src/engine/test-summary.js';

describe('test summaries', () => {
  it('reads the totals line of common runners', () => {
    expect(testPassSummary(['', ' Test Files  24 passed (24)', '      Tests  429 passed | 1 skipped (430)', '   Duration  11.35s'])).toBe(
      'Tests 429 passed | 1 skipped (430)',
    );
    expect(testPassSummary(['Tests:       5 passed, 5 total', 'Time: 1.2 s'])).toBe('Tests: 5 passed, 5 total');
    expect(testPassSummary(['  9 skipped', '  125 passed (2.3m)'])).toBe('125 passed (2.3m)');
    expect(testPassSummary(['  12 passing (40ms)'])).toBe('12 passing (40ms)');
    expect(testPassSummary(['\u001b[32m===== 7 passed in 0.12s =====\u001b[0m'])).toBe('===== 7 passed in 0.12s =====');
  });

  it('returns null when a command prints no totals', () => {
    expect(testPassSummary(['> eslint .', '', 'built in 2.11s'])).toBeNull();
  });

  it('prefers the failure count, then the last output line', () => {
    expect(testFailureSummary(['Tests  2 failed | 427 passed (429)', 'Duration 3s'])).toBe('Tests 2 failed | 427 passed (429)');
    expect(testFailureSummary(['error: something broke', '  '])).toBe('error: something broke');
    expect(testFailureSummary([])).toBe('Command failed');
  });
});
