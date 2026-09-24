/**
 * One-line summaries of a verification command's output, taken from the
 * runner's own totals line (Vitest, Jest, Playwright, Mocha, pytest, Node's
 * built-in `node --test`…) so the Tests tab can say "429 passed | 1 skipped"
 * instead of only an exit code.
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

interface NodeTestTotals {
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
  cancelled: number;
}

/**
 * `node --test` prints its totals one per line, count last (`# pass 2` with
 * the TAP reporter, `ℹ pass 2` with the spec reporter), which no "N passed"
 * pattern matches. Reads the last such block.
 */
function nodeTestTotals(lines: string[]): NodeTestTotals | null {
  const found: Partial<Record<keyof NodeTestTotals, number>> = {};
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(?:#|ℹ)\s*(tests|pass|fail|skipped|cancelled)\s+(\d+)$/.exec(clean(lines[i]!));
    if (!m) continue;
    const key = m[1] as keyof NodeTestTotals;
    if (found[key] === undefined) found[key] = Number(m[2]);
    if (key === 'tests') break;
  }
  if (found.tests === undefined || found.pass === undefined) return null;
  return { tests: found.tests, pass: found.pass, fail: found.fail ?? 0, skipped: found.skipped ?? 0, cancelled: found.cancelled ?? 0 };
}

function describeNodeTotals(t: NodeTestTotals): string {
  const parts = [t.fail ? `${t.fail} failed` : null, t.cancelled ? `${t.cancelled} cancelled` : null, `${t.pass} passed`, t.skipped ? `${t.skipped} skipped` : null];
  return `${parts.filter(Boolean).join(' | ')} (${t.tests})`;
}

/** The totals line of a passing run, or null when the command prints none (lint, build). */
export function testPassSummary(lines: string[]): string | null {
  const line = lastMatching(lines, /\b\d+\s+(?:passed|passing|tests? passed)\b/i);
  if (line) return line;
  const node = nodeTestTotals(lines);
  return node ? describeNodeTotals(node) : null;
}

/** The most informative line of a failing run: its failure count, else its last output. */
export function testFailureSummary(lines: string[]): string {
  const line = lastMatching(lines, /\b\d+\s+(?:failed|failing|errors?|failures?)\b/i);
  if (line) return line;
  const node = nodeTestTotals(lines);
  if (node && (node.fail || node.cancelled)) return describeNodeTotals(node);
  return lastMatching(lines, /\S/) ?? 'Command failed';
}
