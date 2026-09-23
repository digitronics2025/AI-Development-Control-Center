/**
 * One-line summaries of a verification command's output, taken from the
 * runner's own totals line (Vitest, Jest, Playwright, Mocha, pytest…) so the
 * Tests tab can say "429 passed | 1 skipped" instead of only an exit code.
 */

const MAX = 200;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function clean(line: string): string {
  const text = line.replace(ANSI, '').replace(/\s+/g, ' ').trim();
  return text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text;
}

function lastMatching(lines: string[], pattern: RegExp): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = clean(lines[i]!);
    if (pattern.test(line)) return line;
  }
  return null;
}

/** The totals line of a passing run, or null when the command prints none (lint, build). */
export function testPassSummary(lines: string[]): string | null {
  return lastMatching(lines, /\b\d+\s+(?:passed|passing|tests? passed)\b/i);
}

/** The most informative line of a failing run: its failure count, else its last output. */
export function testFailureSummary(lines: string[]): string {
  return (
    lastMatching(lines, /\b\d+\s+(?:failed|failing|errors?|failures?)\b/i) ??
    lastMatching(lines, /\S/) ??
    'Command failed'
  );
}
