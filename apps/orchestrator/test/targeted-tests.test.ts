import { describe, expect, it } from 'vitest';
import { MAX_TARGETED_FILES, narrowCommand, runnerInvocation, targetedCommand, testFileOf, testFilesOf } from '../src/engine/targeted-tests.js';

/** Targeted baseline runs (docs/plans/LEAD_TIME_PLAN.md §3.1). */

describe('test files named by failure ids', () => {
  it('reads the file from Vitest, Jest, Playwright and pytest ids', () => {
    expect(testFileOf('src/test/frontend-wiring.test.tsx > frontend wiring smoke tests > PartnersPage shows a retryable error')).toBe('src/test/frontend-wiring.test.tsx');
    expect(testFileOf('scripts/pin-guard.test.ts [ scripts/pin-guard.test.ts ]')).toBe('scripts/pin-guard.test.ts');
    expect(testFileOf('src/sum.test.js')).toBe('src/sum.test.js');
    expect(testFileOf('sum.spec.mjs')).toBe('sum.spec.mjs');
    // TASK-0008's e2e ids, printed by Playwright on Windows.
    expect(testFileOf('[chromium] › tests\\e2e\\auth.spec.ts › Authentication flows › logout returns to login page')).toBe('tests/e2e/auth.spec.ts');
    expect(testFileOf('tests/test_api.py::test_login')).toBe('tests/test_api.py');
    expect(testFileOf('pkg/api_test.py::TestX::test_y')).toBe('pkg/api_test.py');
  });

  it('names no file for titles, printed lines and paths that are unsafe or not tests', () => {
    for (const id of [
      'PartnersPage shows a retryable error instead of an empty owner breakdown',
      'CLAUDE.md',
      'passes scripts/docs-guard.mjs',
      '../outside.test.ts > x',
      '/abs/path.test.ts > x',
      'C:/abs/path.test.ts > x',
      'src/.hidden/a.test.ts',
      'src/with space.test.ts > x',
      '-p/option.test.ts > x',
      'src/-rf.test.ts > x',
      'src/helpers.ts > x',
    ]) {
      expect(testFileOf(id), id).toBeNull();
    }
  });

  it('keeps each file once, in order', () => {
    expect(testFilesOf(['a.test.ts > x', 'CLAUDE.md', 'b.test.ts > y', 'a.test.ts > z'])).toEqual(['a.test.ts', 'b.test.ts']);
  });
});

describe('the targeted command', () => {
  const scripts = { test: 'vitest run', 'test:e2e': 'npx playwright test', lint: 'eslint .', chained: 'vitest run && node after.js', env: 'CI=1 vitest run' };

  it('narrows an npm script whose body is one test runner', () => {
    expect(targetedCommand('npm test', scripts, ['a.test.ts', 'src/b.test.ts'])).toEqual({ commandLine: 'npm test -- a.test.ts src/b.test.ts', files: ['a.test.ts', 'src/b.test.ts'] });
    expect(targetedCommand('npm run test:e2e', scripts, ['tests/e2e/auth.spec.ts'])?.commandLine).toBe('npm run test:e2e -- tests/e2e/auth.spec.ts');
  });

  it('narrows route files with brackets, passing them in double quotes (found in TASK-0009)', () => {
    const id = 'functions/api/banking/accounts/[id]/unaccounted-now.test.ts > GET /api/banking/accounts/:id/unaccounted-now > defaults asOf to today UTC when omitted';
    expect(testFileOf(id)).toBe('functions/api/banking/accounts/[id]/unaccounted-now.test.ts');
    expect(targetedCommand('npm test', scripts, ['src/a.test.ts', 'functions/api/[id]/b.test.ts'])?.commandLine).toBe('npm test -- src/a.test.ts "functions/api/[id]/b.test.ts"');
    // Only brackets are added: quotes, spaces, `$` and the rest stay refused.
    for (const bad of ['functions/api/[id]"/x.test.ts > t', 'functions/[$(id)]/x.test.ts > t', 'functions/[id] x/x.test.ts > t', '../[id]/x.test.ts > t']) expect(testFileOf(bad), bad).toBeNull();
  });

  it('narrows a runner called directly', () => {
    expect(targetedCommand('npx vitest run', null, ['a.test.ts'])?.commandLine).toBe('npx vitest run a.test.ts');
    expect(targetedCommand('npx playwright test --project=chromium', null, ['e2e/a.spec.ts'])?.commandLine).toBe('npx playwright test --project=chromium e2e/a.spec.ts');
    // pytest is never narrowed: a file can fail alone that passes in the suite, which must not prove anything pre-existing.
    expect(targetedCommand('python -m pytest -q', null, ['tests/test_api.py'])).toBeNull();
    expect(targetedCommand('jest --ci', null, ['src/sum.test.js'])?.commandLine).toBe('jest --ci src/sum.test.js');
  });

  it('refuses whatever it cannot narrow safely, leaving it to the full run', () => {
    const files = ['a.test.ts'];
    expect(targetedCommand('npm run lint', scripts, files)).toBeNull(); // not a test runner
    expect(targetedCommand('npm run chained', scripts, files)).toBeNull(); // more than one program
    expect(targetedCommand('npm run env', scripts, files)).toBeNull(); // an environment prefix
    expect(targetedCommand('npm run missing', scripts, files)).toBeNull();
    expect(targetedCommand('npm test', null, files)).toBeNull(); // no package.json at the baseline
    expect(targetedCommand('pnpm test', scripts, files)).toBeNull(); // passes arguments on differently
    expect(targetedCommand('node check.js', scripts, files)).toBeNull();
    expect(targetedCommand('npx vitest run && echo done', null, files)).toBeNull();
    expect(targetedCommand('npx vitest run', null, [])).toBeNull();
    expect(targetedCommand('npx vitest run', null, ['a b.test.ts'])).toBeNull();
    expect(targetedCommand('npx vitest run', null, Array.from({ length: MAX_TARGETED_FILES + 1 }, (_, i) => `t${i}.test.ts`))).toBeNull();
  });
});

/** Affected tests only (docs/plans/AFFECTED_TESTS_PLAN.md §3.2 rule 7). */
describe('the command narrowed to the tests a change can affect', () => {
  const sha = 'a'.repeat(40);
  const scripts = { test: 'vitest run', 'test:unit': 'vitest run --project unit', jest: 'jest --ci', e2e: 'playwright test', watch: 'vitest', dev: 'vitest watch', related: 'vitest related src/a.ts', changed: 'vitest run --changed HEAD~1', w: 'vitest run -w', chained: 'vitest run && node after.js' };

  it('names the runner of an npm script or a direct call', () => {
    expect(runnerInvocation('npm test', scripts)).toMatchObject({ runner: 'vitest', body: 'vitest run' });
    expect(runnerInvocation('npm run jest', scripts)?.runner).toBe('jest');
    expect(runnerInvocation('npx playwright test', null)?.runner).toBe('playwright');
    expect(runnerInvocation('npm run chained', scripts)).toBeNull();
  });

  it('appends --changed <baseline> --passWithNoTests to one Vitest run', () => {
    expect(narrowCommand('npm test', scripts, sha)).toBe(`npm test -- --changed ${sha} --passWithNoTests`);
    expect(narrowCommand('npm run test:unit', scripts, sha)).toBe(`npm run test:unit -- --changed ${sha} --passWithNoTests`);
    expect(narrowCommand('npx vitest run', null, sha)).toBe(`npx vitest run --changed ${sha} --passWithNoTests`);
    expect(narrowCommand('vitest run', null, 'b'.repeat(64))).toBe(`vitest run --changed ${'b'.repeat(64)} --passWithNoTests`);
    // A bare `vitest` script runs once without a terminal, as the orchestrator starts it.
    expect(narrowCommand('npm run watch', scripts, sha)).toBe(`npm run watch -- --changed ${sha} --passWithNoTests`);
  });

  it('leaves every other command to the whole suite', () => {
    expect(narrowCommand('npm run jest', scripts, sha)).toBeNull(); // Jest: Found for Later
    expect(narrowCommand('npm run e2e', scripts, sha)).toBeNull(); // Playwright
    expect(narrowCommand('python -m pytest', null, sha)).toBeNull();
    expect(narrowCommand('pnpm test', scripts, sha)).toBeNull(); // passes arguments on differently
    expect(narrowCommand('npm run chained', scripts, sha)).toBeNull();
    expect(narrowCommand('npm run dev', scripts, sha)).toBeNull(); // watch mode
    expect(narrowCommand('npm run w', scripts, sha)).toBeNull();
    expect(narrowCommand('npm run related', scripts, sha)).toBeNull(); // already chooses its files
    expect(narrowCommand('npm run changed', scripts, sha)).toBeNull();
    expect(narrowCommand('npm test', null, sha)).toBeNull(); // no package.json
  });

  it('adds nothing but a plain hex commit id to the command line', () => {
    for (const bad of ['HEAD', 'main', 'a'.repeat(39), 'A'.repeat(40), `${'a'.repeat(40)};rm -rf /`, `${'a'.repeat(39)} `, '']) expect(narrowCommand('npm test', scripts, bad), bad).toBeNull();
  });
});
