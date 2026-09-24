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

  it('reads the totals of Node\'s built-in test runner (TAP and spec reporters)', () => {
    const tap = ['TAP version 13', 'ok 1 - adds', '1..2', '# tests 2', '# suites 0', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 48.4'];
    expect(testPassSummary(tap)).toBe('2 passed (2)');
    const spec = ['✔ adds (0.5ms)', 'ℹ tests 3', 'ℹ suites 0', 'ℹ pass 2', 'ℹ fail 1', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0', 'ℹ duration_ms 52.1'];
    expect(testFailureSummary(spec)).toBe('1 failed | 2 passed (3)');
    expect(testPassSummary(['# tests 5', '# pass 4', '# fail 0', '# skipped 1'])).toBe('4 passed | 1 skipped (5)');
    // A cancelled file (e.g. a module that does not load) is a failure, not "the last line".
    expect(testFailureSummary(['# Subtest: test', 'not ok 1 - test', '# tests 1', '# pass 0', '# fail 0', '# cancelled 1', '# duration_ms 48.4'])).toBe('1 cancelled | 0 passed (1)');
  });
});
