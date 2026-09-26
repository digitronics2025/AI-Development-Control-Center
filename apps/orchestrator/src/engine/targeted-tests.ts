/**
 * Targeted baseline runs (docs/plans/LEAD_TIME_PLAN.md §3.1). To learn whether
 * a failure already existed, running only the failing test files on the
 * baseline commit answers in seconds what the whole suite answers in minutes.
 * A targeted run can only prove a failure pre-existing; anything it cannot
 * prove goes to the full baseline run, so the check never gets looser.
 */

/** Beyond this many files a targeted run saves little; the full run decides. */
export const MAX_TARGETED_FILES = 50;

/**
 * Programs that accept test files as positional arguments, after an optional
 * launcher. Each runs every test file in its own isolated context, so a file
 * fails alone as it fails in the suite. pytest is left out: its module state
 * and conftest order can make a file fail alone that passes in the suite, and
 * a narrowed run must never prove a failure pre-existing that is not.
 */
const RUNNERS: RegExp[] = [
  /^(?:npx(?:\s+--no-install)?\s+)?vitest(?:\s|$)/,
  /^(?:npx(?:\s+--no-install)?\s+)?jest(?:\s|$)/,
  /^(?:npx(?:\s+--no-install)?\s+)?playwright\s+test(?:\s|$)/,
];
/** An npm script invocation; other package managers pass arguments on differently and are not targeted. */
const NPM_SCRIPT = /^npm\s+(?:test|t|run(?:-script)?\s+([\w:.@/-]+))$/;
/** Anything that makes a command more than one program run: chaining, pipes, redirection, substitution, env prefixes. */
const COMPOUND = /&&|\|\||[;|<>`]|\$\(|^\s*\w+=/;
/** A relative path that needs no quoting in any shell; no segment starts with a dot (so none is "..") or a dash (never read as an option). */
const SAFE_PATH = /^[\w@+][\w.@+-]*(?:\/[\w@+][\w.@+-]*)*$/;
/**
 * The same, also allowing route-style brackets (`functions/api/accounts/[id]/x.test.ts`,
 * Cloudflare Pages and Next.js route files). Brackets are glob characters in POSIX
 * shells, so such a path is passed in double quotes; nothing else in it needs them.
 */
const BRACKET_PATH = /^[\w@+[][\w.@+\-[\]]*(?:\/[\w@+[][\w.@+\-[\]]*)*$/;
const safePath = (f: string) => SAFE_PATH.test(f) || BRACKET_PATH.test(f);
const shellArg = (f: string) => (SAFE_PATH.test(f) ? f : `"${f}"`);
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)test_[^/]+\.py|_test\.py)$/;

function isRunner(line: string): boolean {
  return !COMPOUND.test(line) && RUNNERS.some((r) => r.test(line));
}

export type TestRunner = 'vitest' | 'jest' | 'playwright';

export interface RunnerInvocation {
  runner: TestRunner;
  /** The single runner call: the npm script's body, or the command line itself. */
  body: string;
  /** The npm script's name, or null when the runner is called directly. */
  script: string | null;
  /** The command line with `args` passed on to the runner (already shell-safe). */
  append(args: string[]): string;
}

/**
 * How extra arguments reach the test runner of `commandLine`, or null when the
 * command is not one runner call that can take them: an npm script whose body
 * is one `vitest`/`jest`/`playwright test` run (arguments after `--`), or such a
 * runner called directly. `scripts` are the package.json scripts to read the
 * body from (null when there are none). Shared by the targeted baseline run and
 * the affected-tests selection (docs/plans/AFFECTED_TESTS_PLAN.md §3.2).
 */
export function runnerInvocation(commandLine: string, scripts: Record<string, string> | null): RunnerInvocation | null {
  const line = commandLine.trim().replace(/\s+/g, ' ');
  const script = NPM_SCRIPT.exec(line);
  const body = script ? scripts?.[script[1] ?? 'test'] : line;
  if (typeof body !== 'string') return null;
  const trimmed = body.trim().replace(/\s+/g, ' ');
  if (!isRunner(trimmed)) return null;
  const runner: TestRunner = RUNNERS[0]!.test(trimmed) ? 'vitest' : RUNNERS[1]!.test(trimmed) ? 'jest' : 'playwright';
  return { runner, body: trimmed, script: script ? (script[1] ?? 'test') : null, append: (args) => (script ? `${line} -- ${args.join(' ')}` : `${line} ${args.join(' ')}`) };
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
  if (!safePath(file) || file.split('/').includes('..') || !TEST_FILE.test(file)) return null;
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
  if (!files.length || files.length > MAX_TARGETED_FILES || files.some((f) => !safePath(f))) return null;
  const invocation = runnerInvocation(commandLine, scripts);
  return invocation ? { commandLine: invocation.append(files.map(shellArg)), files } : null;
}

/** A Git commit id: 40 (SHA-1) or 64 (SHA-256) lowercase hex characters, the only text a narrowed command gains. */
export const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Vitest runs that already choose their own files, or never finish: watch mode and the other subcommands. */
const VITEST_SELF_SELECTING = /(?:^|\s)(?:--changed|--related|--watch|-w)(?:[\s=]|$)|\bvitest (?:watch|dev|related|bench|list|init|typecheck)\b/;

/**
 * The same Vitest command narrowed to the tests whose imports reach a file
 * changed since `baselineCommit` (AFFECTED_TESTS_PLAN §3.2 rule 7), or null
 * when it cannot be: not one Vitest run, a run that already selects its own
 * files or watches, an npm script with a `pre`/`post` lifecycle hook (npm runs
 * it around the tests, and it may write or delete files the import graph cannot
 * see), or a commit id that is not plain hex. Vitest reads the
 * changes from Git itself (committed since the commit, staged, unstaged and
 * untracked) and runs everything when package.json or its config changed.
 */
export function narrowCommand(commandLine: string, scripts: Record<string, string> | null, baselineCommit: string): string | null {
  if (!COMMIT_ID.test(baselineCommit)) return null;
  const invocation = runnerInvocation(commandLine, scripts);
  if (!invocation || invocation.runner !== 'vitest' || VITEST_SELF_SELECTING.test(invocation.body)) return null;
  if (invocation.script && (scripts?.[`pre${invocation.script}`] !== undefined || scripts?.[`post${invocation.script}`] !== undefined)) return null;
  return invocation.append(['--changed', baselineCommit, '--passWithNoTests']);
}
