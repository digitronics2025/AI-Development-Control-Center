import { describe, expect, it } from 'vitest';
import { fullSuiteReason, selectTests, type PathChange } from '../src/engine/test-selection.js';

/** Affected tests only: every rule of docs/plans/AFFECTED_TESTS_PLAN.md §3.2, with its reason. */
describe('which tests a tests stage runs', () => {
  const sha = 'c'.repeat(40);
  const scripts = { test: 'vitest run', jest: 'jest' };
  const base = {
    repo: { testSelection: 'changed' as const },
    command: { kind: 'test' as const, command: 'npm test' },
    stageKind: 'tests' as const,
    baselineCommit: sha,
    changed: [{ path: 'src/lib/price.ts', status: 'modified' }, { path: 'src/lib/price.test.ts', status: 'added' }] as PathChange[],
    scripts,
  };

  it('narrows a Vitest test command when every change is source the import graph covers', () => {
    expect(selectTests(base)).toEqual({ mode: 'changed', commandLine: `npm test -- --changed ${sha} --passWithNoTests`, baselineCommit: sha, files: 2 });
    for (const path of ['a.js', 'b.jsx', 'c.ts', 'd.tsx', 'e.mjs', 'f.cjs', 'g.mts', 'h.cts', 'functions/api/[id]/x.ts', 'src/types.d.ts']) {
      expect(selectTests({ ...base, changed: [{ path, status: 'modified' }] }).mode, path).toBe('changed');
    }
  });

  it('rule 1: keeps today’s behaviour unless the repository opted in, and only for a tests stage’s test command', () => {
    expect(selectTests({ ...base, repo: { testSelection: 'full' } })).toEqual({ mode: 'full', reason: null });
    expect(selectTests({ ...base, stageKind: 'command' })).toEqual({ mode: 'full', reason: null });
    for (const kind of ['lint', 'typecheck', 'build', 'e2e', 'smoke', 'other'] as const) expect(selectTests({ ...base, command: { kind, command: 'npm test' } })).toEqual({ mode: 'full', reason: null });
  });

  it('rule 2: needs a plain Git baseline commit', () => {
    expect(selectTests({ ...base, baselineCommit: null })).toEqual({ mode: 'full', reason: 'No Git baseline' });
    expect(selectTests({ ...base, baselineCommit: 'HEAD' })).toEqual({ mode: 'full', reason: 'No Git baseline' });
  });

  it('rule 3: needs the task’s changes, and some', () => {
    expect(selectTests({ ...base, changed: null })).toEqual({ mode: 'full', reason: "Could not read the task's changes" });
    expect(selectTests({ ...base, changed: [] })).toEqual({ mode: 'full', reason: 'Nothing changed' });
  });

  it('rule 4: a deleted or renamed file runs the whole suite', () => {
    expect(selectTests({ ...base, changed: [...base.changed, { path: 'src/old.ts', status: 'deleted' }] })).toEqual({ mode: 'full', reason: 'A file was deleted or renamed (src/old.ts)' });
  });

  it('rule 5: a file that is not JavaScript or TypeScript source runs the whole suite', () => {
    for (const path of ['fixtures.json', 'src/__snapshots__/a.test.ts.snap', '.env', 'tsconfig.json', 'package-lock.json', 'README.md', 'db/0001.sql', 'CLAUDE.md', 'src/app.vue']) {
      expect(selectTests({ ...base, changed: [{ path, status: 'modified' }] }), path).toEqual({ mode: 'full', reason: `${path} is not source code; tests may read it` });
    }
  });

  it('rule 6: test infrastructure runs the whole suite', () => {
    for (const path of ['vitest.setup.ts', 'test/setup.ts', 'src/global-setup.ts', 'test/globalSetup.ts', 'test/teardown.js', 'vitest.config.ts', 'src/app.config.ts', 'src/__mocks__/fs.ts', 'test/fixtures/users.ts', 'src/test-utils/render.tsx', 'src/testing/helpers.ts', 'src/__fixtures__/a.ts']) {
      expect(selectTests({ ...base, changed: [{ path, status: 'modified' }] }), path).toEqual({ mode: 'full', reason: `${path} configures or supports every test` });
    }
    // A name that only contains the word is ordinary source.
    expect(fullSuiteReason({ path: 'src/configurator.ts', status: 'modified' })).toBeNull();
    expect(fullSuiteReason({ path: 'src/setupWizard.ts', status: 'modified' })).toBeNull();
  });

  it('rule 7: only a Vitest command can be narrowed', () => {
    expect(selectTests({ ...base, command: { kind: 'test', command: 'npm run jest' } })).toEqual({ mode: 'full', reason: 'Only Vitest commands can run affected tests' });
    expect(selectTests({ ...base, command: { kind: 'test', command: 'pnpm test' } })).toEqual({ mode: 'full', reason: 'Only Vitest commands can run affected tests' });
    expect(selectTests({ ...base, scripts: null })).toEqual({ mode: 'full', reason: 'Only Vitest commands can run affected tests' });
  });

  it('checks the rules in order and names the first file that needs the whole suite', () => {
    const changed: PathChange[] = [{ path: 'data.json', status: 'modified' }, { path: 'gone.ts', status: 'deleted' }];
    expect(selectTests({ ...base, changed }).mode).toBe('full');
    expect(selectTests({ ...base, changed })).toEqual({ mode: 'full', reason: 'data.json is not source code; tests may read it' });
  });
});
