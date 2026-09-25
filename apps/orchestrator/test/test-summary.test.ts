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

describe('failing test ids', () => {
  it('keeps each failing test once: a bare title that another id names in full is dropped (LEAD_TIME_PLAN §3.2)', async () => {
    const { failureIdsIn } = await import('../src/engine/test-summary.js');
    // TASK-0008's unit output on tenten-accounting-in, reduced to the lines that name failures.
    const vitest = [
      ' × PartnersPage shows a retryable error instead of an empty owner breakdown when the cards fail to load 31ms',
      ' × passes scripts/docs-guard.mjs 812ms',
      '   ✗ CLAUDE.md',
      ' FAIL  scripts/fix-name-polluted-sku.test.ts [ scripts/fix-name-polluted-sku.test.ts ]',
      ' FAIL  scripts/merge-duplicate-supplier-prices.test.ts [ scripts/merge-duplicate-supplier-prices.test.ts ]',
      ' FAIL  scripts/pin-guard.test.ts [ scripts/pin-guard.test.ts ]',
      ' FAIL  scripts/strip-brand-from-sku.test.ts [ scripts/strip-brand-from-sku.test.ts ]',
      ' FAIL  scripts/docs-guard.test.ts > docs/systems stays cheap to read > passes scripts/docs-guard.mjs',
      ' FAIL  src/test/frontend-wiring.test.tsx > frontend wiring smoke tests > PartnersPage shows a retryable error instead of an empty owner breakdown when the cards fail to load',
      '      Tests  2 failed | 9070 passed (9072)',
    ].join('\n');
    expect(failureIdsIn(vitest)).toEqual([
      // A line a test printed: not a title of another id, so it is kept, and it appears on both sides of a comparison.
      'CLAUDE.md',
      'scripts/docs-guard.test.ts > docs/systems stays cheap to read > passes scripts/docs-guard.mjs',
      'scripts/fix-name-polluted-sku.test.ts [ scripts/fix-name-polluted-sku.test.ts ]',
      'scripts/merge-duplicate-supplier-prices.test.ts [ scripts/merge-duplicate-supplier-prices.test.ts ]',
      'scripts/pin-guard.test.ts [ scripts/pin-guard.test.ts ]',
      'scripts/strip-brand-from-sku.test.ts [ scripts/strip-brand-from-sku.test.ts ]',
      'src/test/frontend-wiring.test.tsx > frontend wiring smoke tests > PartnersPage shows a retryable error instead of an empty owner breakdown when the cards fail to load',
    ]);
    // Playwright names every test in full once: nothing changes.
    const playwright = ['  2 failed', '    [chromium] › tests\\e2e\\auth.spec.ts:30:3 › Authentication flows › logout returns to login page', '    [chromium] › tests\\e2e\\quick-sale.spec.ts:8:3 › Quick Sale flow › sees the Quick Sale page with form sections', '  48 passed (3.1m)'].join('\n');
    expect(failureIdsIn(playwright)).toEqual([
      '[chromium] › tests\\e2e\\auth.spec.ts › Authentication flows › logout returns to login page',
      '[chromium] › tests\\e2e\\quick-sale.spec.ts › Quick Sale flow › sees the Quick Sale page with form sections',
    ]);
    // Jest's bare title has no full form to defer to: kept.
    expect(failureIdsIn('  ✕ adds numbers (5 ms)\nFAIL src/sum.test.js')).toEqual(['adds numbers', 'src/sum.test.js']);
  });
});
