/**
 * Targeted baseline runs (docs/plans/LEAD_TIME_PLAN.md §3.1). To learn whether
 * a failure already existed, running only the failing test files on the
 * baseline commit answers in seconds what the whole suite answers in minutes.
 * A targeted run can only prove a failure pre-existing; anything it cannot
 * prove goes to the full baseline run, so the check never gets looser.
 */

/** Beyond this many files a targeted run saves little; the full run decides. */
export const MAX_TARGETED_FILES = 50;

/** Programs that accept test files as positional arguments, after an optional launcher. */
const RUNNERS: RegExp[] = [
  /^(?:npx(?:\s+--no-install)?\s+)?vitest(?:\s|$)/,
  /^(?:npx(?:\s+--no-install)?\s+)?jest(?:\s|$)/,
  /^(?:npx(?:\s+--no-install)?\s+)?playwright\s+test(?:\s|$)/,
  /^(?:python3?\s+-m\s+)?pytest(?:\s|$)/,
];
/** An npm script invocation; other package managers pass arguments on differently and are not targeted. */
const NPM_SCRIPT = /^npm\s+(?:test|t|run(?:-script)?\s+([\w:.@/-]+))$/;
/** Anything that makes a command more than one program run: chaining, pipes, redirection, substitution, env prefixes. */
const COMPOUND = /&&|\|\||[;|<>`]|\$\(|^\s*\w+=/;
/** A relative path that needs no quoting in any shell; no segment starts with a dot, so none is "..". */
const SAFE_PATH = /^[\w@+-][\w.@+-]*(?:\/[\w@+-][\w.@+-]*)*$/;
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)test_[^/]+\.py|_test\.py)$/;

function isRunner(line: string): boolean {
  return !COMPOUND.test(line) && RUNNERS.some((r) => r.test(line));
}

/**
 * The file a failure id names: Playwright `[project] › file › title`, Vitest
 * `file > suite > title` or `file [ file ]`, pytest `file::test`, Jest `file`.
 * Null when the id names no test file (a title alone, a line a test printed).
 */
export function testFileOf(id: string): string | null {
  const playwright = /^\[[^\]]+\] › (.+?) › /.exec(id);
  const raw = playwright ? playwright[1]! : id.split(' > ')[0]!.split('::')[0]!.split(' [ ')[0]!;
  const file = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!SAFE_PATH.test(file) || file.split('/').includes('..') || !TEST_FILE.test(file)) return null;
  return file;
}

/** The distinct test files named by a run's failure ids, in order. */
export function testFilesOf(failures: string[]): string[] {
  return [...new Set(failures.map(testFileOf).filter((f): f is string => f !== null))];
}

export interface TargetedCommand {
  commandLine: string;
  files: string[];
}

/**
 * The same command, narrowed to `files`, or null when it cannot be narrowed
 * safely. `scripts` are the baseline commit's package.json scripts (null when
 * it has none); `files` must already be known to exist at that commit.
 */
export function targetedCommand(commandLine: string, scripts: Record<string, string> | null, files: string[]): TargetedCommand | null {
  if (!files.length || files.length > MAX_TARGETED_FILES || files.some((f) => !SAFE_PATH.test(f))) return null;
  const line = commandLine.trim().replace(/\s+/g, ' ');
  const script = NPM_SCRIPT.exec(line);
  if (script) {
    const body = scripts?.[script[1] ?? 'test'];
    if (typeof body !== 'string' || !isRunner(body.trim())) return null;
    return { commandLine: `${line} -- ${files.join(' ')}`, files };
  }
  if (!isRunner(line)) return null;
  return { commandLine: `${line} ${files.join(' ')}`, files };
}
