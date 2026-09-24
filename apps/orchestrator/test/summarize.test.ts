import { describe, expect, it } from 'vitest';
import { extractOperatorItems, latestOperatorItems } from '../src/engine/report.js';
import { parseVerdict, summarize } from '../src/engine/runners.js';

// Shapes taken from real Claude Code stage outputs.
describe('summarize', () => {
  it('prefers the Summary section over working notes before it', () => {
    const review = [
      'Diff claims checked against the code and the nightly log; finishing the verdict.',
      '',
      '**Summary**',
      '',
      'The change is three doc edits (history entry, four follow-ups, one merged security paragraph).',
      '',
      '**Issues**',
      '',
      'VERDICT: PASS',
    ].join('\n');
    expect(summarize(review)).toBe('The change is three doc edits (history entry, four follow-ups, one merged security paragraph).');
  });

  it('reads numbered headings such as a plan goal', () => {
    expect(summarize('## 1. Goal\n\nProve, by running it, that the console works.\n\n## 2. Scope')).toBe(
      'Prove, by running it, that the console works.',
    );
    expect(summarize('## Findings\n\nI traced the app as three loops.')).toBe('I traced the app as three loops.');
  });

  it('never returns a bare label, table row or verdict line', () => {
    const verification = [
      '**Verdict: not passed.** Two things stop it.',
      '',
      '**Criteria**',
      '',
      '| # | Criterion | Result |',
      '|---|---|---|',
      'VERDICT: FAIL',
    ].join('\n');
    expect(summarize(verification)).toBe('Verdict: not passed. Two things stop it.');
    expect(summarize('**Criteria**\n\n| a | b |\n\nVERDICT: PASS')).toBeNull();
  });

  it('accepts an inline summary label and strips inline code', () => {
    expect(summarize('Summary: Fixed the `parser` and re-ran the suite.')).toBe('Fixed the parser and re-ran the suite.');
  });

  it('truncates long lines', () => {
    expect(summarize('x'.repeat(300), 50)).toHaveLength(50);
  });
});

describe('extractOperatorItems', () => {
  it('collects NEEDS OPERATOR lines from review and verification, bold or listed, once each', () => {
    const verification = '- NEEDS OPERATOR: Switch bindMode to loopback.\n**NEEDS OPERATOR:** Provide a ping URL.\nNot this line.';
    const review = 'NEEDS OPERATOR: Switch bindMode to loopback.';
    expect(extractOperatorItems(review, verification, null)).toEqual(['Switch bindMode to loopback.', 'Provide a ping URL.']);
    expect(extractOperatorItems('nothing to see')).toEqual([]);
  });
});

describe('latestOperatorItems', () => {
  it('takes the verification list when there is one, so a restated concern is not listed twice', () => {
    const review = 'NEEDS OPERATOR: The messenger path is unit-tested only.';
    const verification = 'NEEDS OPERATOR: The messenger transport has only been tested with a fake transport.';
    expect(latestOperatorItems(review, verification)).toEqual(['The messenger transport has only been tested with a fake transport.']);
    expect(latestOperatorItems(review, 'All criteria met.')).toEqual([]);
    expect(latestOperatorItems(review, null)).toEqual(['The messenger path is unit-tested only.']);
  });
});

describe('parseVerdict', () => {
  it('takes the last verdict line, bold or not', () => {
    expect(parseVerdict('VERDICT: FAIL\n...\n**VERDICT: PASS**')).toBe('PASS');
    expect(parseVerdict('no verdict here')).toBeNull();
  });
});

describe('summarize with the v4 report shape', () => {
  it('never returns a CAUSE line, and takes the Summary sentence before the marker lines', () => {
    expect(summarize('CAUSE: code\n\nVERDICT: FAIL')).toBeNull();
    const review = ['## Summary', '', 'One blocking defect: the null check the request asked for is missing.', '', '## Issues', '', '- blocking src/a.ts:12', '', 'CAUSE: code', '', 'VERDICT: FAIL'].join('\n');
    expect(summarize(review)).toBe('One blocking defect: the null check the request asked for is missing.');
  });
});
