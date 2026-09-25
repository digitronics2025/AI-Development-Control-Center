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

// ---------------------------------------------------------------------------
// Failing test ids (docs/plans/AUTOPILOT_GATES_PLAN.md §3.B): which tests
// failed, read from the whole output while it streams, so a failure can be
// compared with the same command's result on the baseline commit.
// ---------------------------------------------------------------------------

/** How many ids one run keeps; beyond it the run's failures cannot be compared. */
export const MAX_FAILURE_IDS = 500;

/** Vitest, Jest, Mocha, node:test, TAP and pytest per-test failure lines. */
const FAILURE_LINE = /^(?:FAIL|✕|×|✗|not ok\s+\d+\s*-?|FAILED)\s+(.+)$/;
/** Playwright's summary block: `  10 failed` followed by `[project] › file:line:col › title` lines. */
const PLAYWRIGHT_BLOCK = /^\d+ failed$/;
const PLAYWRIGHT_ENTRY = /^\[[^\]]+\] › .+/;

/**
 * One failing test's id, stable across two runs of the same suite: no colour,
 * no timing, no line and column numbers (a task may move a test within its file),
 * no pytest failure reason. Digits in names are kept: "case 1" is not "case 2".
 */
export function normalizeTestId(raw: string): string {
  return raw
    .replace(ANSI, '')
    .replace(/\s+/g, ' ')
    .trim()
    // Playwright pads a title with a box-drawing rule: decoration, not part of the name.
    .replace(/\s*[─━]+$/, '')
    .replace(/\s*\(?\d+(?:\.\d+)?\s?m?s\)?$/, '')
    .replace(/(\.[a-z]{1,5}):\d+(?::\d+)?\b/gi, '$1')
    .slice(0, 300);
}

/**
 * Collects failing test ids from a command's output, a line at a time, up
 * to `MAX_FAILURE_IDS`. `overflow` says more failed than were kept, so the
 * list is not complete and cannot prove anything pre-existing.
 */
export class FailureIdCollector {
  private readonly ids = new Set<string>();
  private inPlaywrightBlock = false;
  overflow = false;

  constructor(private readonly limit = MAX_FAILURE_IDS) {}

  push(rawLine: string): void {
    const line = rawLine.replace(ANSI, '').trim();
    if (PLAYWRIGHT_BLOCK.test(line)) {
      this.inPlaywrightBlock = true;
      return;
    }
    if (this.inPlaywrightBlock) {
      if (PLAYWRIGHT_ENTRY.test(line)) return this.add(line);
      this.inPlaywrightBlock = false;
    }
    const match = FAILURE_LINE.exec(line);
    if (match) this.add(line.startsWith('FAILED') ? match[1]!.replace(/ - .*$/, '') : match[1]!);
  }

  private add(raw: string): void {
    const id = normalizeTestId(raw);
    if (!id || this.ids.has(id)) return;
    if (this.ids.size >= this.limit) {
      this.overflow = true;
      return;
    }
    this.ids.add(id);
  }

  list(): string[] {
    return [...this.ids].sort();
  }
}

/** Failing test ids named in runner output (the Chairman's failure signatures use the first `limit`). */
export function failureIdsIn(output: string, limit = MAX_FAILURE_IDS): string[] {
  const collector = new FailureIdCollector(limit);
  for (const line of output.split('\n')) collector.push(line);
  return collector.list();
}
