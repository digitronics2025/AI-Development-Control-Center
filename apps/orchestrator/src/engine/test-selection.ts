/**
 * Affected tests only (docs/plans/AFFECTED_TESTS_PLAN.md §3.2). On a repository
 * set to `testSelection: 'changed'`, a tests stage's Vitest `test` command runs
 * only the tests whose imports reach a file the task changed. Every rule here
 * fails closed: whatever cannot be shown safe runs the whole suite, with the
 * reason said in plain words.
 */
import type { RepositoryCommand, StageKind } from '@acc/shared';
import type { RepositoryRecord } from '../store/store.js';
import { COMMIT_ID, narrowCommand, runnerInvocation } from './targeted-tests.js';

export interface PathChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

export type Selection =
  | { mode: 'changed'; commandLine: string; baselineCommit: string; files: number }
  /** `reason` null: nothing asked for a narrower run (the repository or the command), today's behaviour. */
  | { mode: 'full'; reason: string | null };

/** JavaScript and TypeScript modules: the only files a Vitest import graph can see. */
const SOURCE = /\.(?:[cm]?[jt]sx?)$/i;
/** Files that configure or support every test, whatever imports them. */
const INFRASTRUCTURE_NAME = /(?:^|[.\-_])(?:setup|global-setup|globalsetup|teardown|config)(?:[.\-_]|$)/i;
const INFRASTRUCTURE_DIR = new Set(['__mocks__', '__fixtures__', 'fixtures', 'test-utils', 'testing']);

/** The reason a changed file needs the whole suite, or null when the import graph covers it. */
export function fullSuiteReason(change: PathChange): string | null {
  if (change.status === 'deleted') return `A file was deleted or renamed (${change.path})`;
  const segments = change.path.split('/');
  const name = segments.at(-1) ?? change.path;
  if (!SOURCE.test(name)) return `${change.path} is not source code; tests may read it`;
  if (INFRASTRUCTURE_NAME.test(name) || segments.slice(0, -1).some((s) => INFRASTRUCTURE_DIR.has(s.toLowerCase()))) return `${change.path} configures or supports every test`;
  return null;
}

export function selectTests(input: {
  repo: Pick<RepositoryRecord, 'testSelection'>;
  command: Pick<RepositoryCommand, 'kind' | 'command'>;
  stageKind: StageKind;
  baselineCommit: string | null;
  /** The task's changes against the baseline commit; null when they could not be read. */
  changed: PathChange[] | null;
  /** The working tree's package.json scripts; null when there are none. */
  scripts: Record<string, string> | null;
}): Selection {
  // Rule 1: today's behaviour unless the repository opted in, and only for a tests stage's `test` command.
  if (input.repo.testSelection !== 'changed' || input.stageKind !== 'tests' || input.command.kind !== 'test') return { mode: 'full', reason: null };
  // Rule 2
  if (!input.baselineCommit || !COMMIT_ID.test(input.baselineCommit)) return { mode: 'full', reason: 'No Git baseline' };
  // Rule 3
  if (input.changed === null) return { mode: 'full', reason: "Could not read the task's changes" };
  if (input.changed.length === 0) return { mode: 'full', reason: 'Nothing changed' };
  // Rules 4–6, first file first.
  for (const change of input.changed) {
    const reason = fullSuiteReason(change);
    if (reason) return { mode: 'full', reason };
  }
  // Rule 7: npm runs a script's pre/post hooks around it, and they may write or delete files the import graph cannot see.
  const script = runnerInvocation(input.command.command, input.scripts)?.script;
  const hook = script ? [`pre${script}`, `post${script}`].find((h) => input.scripts?.[h] !== undefined) : undefined;
  if (hook) return { mode: 'full', reason: `npm runs the ${hook} script around it, which may change files` };
  const commandLine = narrowCommand(input.command.command, input.scripts, input.baselineCommit);
  if (!commandLine) return { mode: 'full', reason: 'Only Vitest commands can run affected tests' };
  return { mode: 'changed', commandLine, baselineCommit: input.baselineCommit, files: input.changed.length };
}
