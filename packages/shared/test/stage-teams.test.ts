import { describe, expect, it } from 'vitest';
import {
  independentOverlaps,
  pathInScope,
  pathPrefixSchema,
  repositoryCommandSchema,
  scopesOverlap,
  stageDefinitionSchema,
  validateWorkflow,
  workUnitManifestSchema,
} from '../src/index.js';

/** docs/plans/STAGE_TEAMS_PLAN.md §7.1 */

const profile = (stage: Record<string, unknown>) => ({
  id: 'teams',
  name: 'Teams',
  stages: [
    { key: 'work', name: 'Work', role: 'investigator', permissionLevel: 1, next: 'review', ...stage },
    { key: 'review', name: 'Review', role: 'reviewer', verdict: true, next: 'complete', onFail: 'work' },
  ],
});
const messages = (input: unknown) => validateWorkflow(input).issues.map((i) => i.message);

const fixed = (workers: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({ team: { mode: 'fixed' as const, maxWorkers: 2, workers, ...extra } });

describe('Stage Team configuration', () => {
  it('accepts a fixed read-only team and an adaptive writing team', () => {
    expect(messages(profile(fixed([{ key: 'a', focus: 'Architecture' }, { key: 'b', focus: 'Risks', agentId: 'codex', effort: 'high' }])))).toEqual([]);
    expect(messages(profile({ role: 'implementer', permissionLevel: 2, team: { mode: 'adaptive', maxWorkers: 3 } }))).toEqual([]);
  });

  it('keeps every existing stage definition exactly as it parses today', () => {
    const plain = stageDefinitionSchema.parse({ key: 'x', name: 'X', role: 'implementer', next: 'complete' });
    expect(plain.team).toBeUndefined();
    expect(repositoryCommandSchema.parse({ id: 't', name: 'Test', command: 'npm test', kind: 'test' }).parallelSafe).toBeUndefined();
  });

  it('rejects teams that could weaken a gate', () => {
    expect(messages(profile({ ...fixed([{ key: 'a', focus: 'A' }]) }))).toContain('A fixed team needs 2 to 4 workers');
    expect(messages(profile({ role: 'implementer', permissionLevel: 2, ...fixed([{ key: 'a', focus: 'A' }, { key: 'b', focus: 'B' }]) }))).toContain(
      'A fixed team runs only on a read-only (Level 1) stage; use an adaptive team for stages that change files',
    );
    expect(messages(profile({ role: 'deployer', permissionLevel: 4, team: { mode: 'adaptive', maxWorkers: 2 } }))).toContain('Staging and production stages never run as a team');
    expect(messages(profile(fixed([{ key: 'a', focus: 'A' }, { key: 'a', focus: 'B' }])))).toContain('Worker key "a" is used twice');
    expect(messages(profile({ role: 'implementer', permissionLevel: 2, team: { mode: 'adaptive', maxWorkers: 2, workers: [{ key: 'a', focus: 'A' }] } }))).toContain(
      'An adaptive team takes its work units from the plan, not from a worker list',
    );
    expect(messages({ ...profile({}), stages: [{ key: 'work', name: 'Work', role: 'tester', kind: 'tests', permissionLevel: 2, next: 'complete', team: { mode: 'adaptive', maxWorkers: 2 } }] })).toContain(
      'Only agent stages can run as a team',
    );
    // The schema caps the size of any team.
    expect(messages(profile({ team: { mode: 'adaptive', maxWorkers: 5 } })).length).toBeGreaterThan(0);
    expect(messages(profile(fixed([1, 2, 3, 4, 5].map((n) => ({ key: `w${n}`, focus: `F${n}` }))))).length).toBeGreaterThan(0);
  });

  it('gives a review team exactly one primary, full-coverage reviewer', () => {
    const review = (workers: Array<Record<string, unknown>>) => ({
      id: 'teams',
      name: 'Teams',
      stages: [
        { key: 'work', name: 'Work', role: 'implementer', permissionLevel: 2, next: 'review' },
        { key: 'review', name: 'Review', role: 'reviewer', verdict: true, next: 'complete', onFail: 'work', team: { mode: 'fixed', maxWorkers: 2, workers } },
      ],
    });
    expect(messages(review([{ key: 'full', focus: 'Whole diff', primary: true }, { key: 'risk', focus: 'Security' }]))).toEqual([]);
    expect(messages(review([{ key: 'full', focus: 'Whole diff' }, { key: 'risk', focus: 'Security' }]))).toContain('A review team needs exactly one primary reviewer, who covers the whole diff');
    expect(messages(review([{ key: 'full', focus: 'Whole diff', primary: true }, { key: 'risk', focus: 'Security', primary: true }]))).toContain('A review team needs exactly one primary reviewer, who covers the whole diff');
    expect(messages(profile(fixed([{ key: 'a', focus: 'A', primary: true }, { key: 'b', focus: 'B' }])))).toContain('Only a review (verdict) team has a primary reviewer');
  });
});

describe('work-unit manifests', () => {
  const unit = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: key, goal: `Do ${key}`, pathPrefixes: [`${key}/`], ...extra });
  const manifest = (units: unknown[]) => ({ version: 1, stage: 'implement', units });
  const errors = (m: unknown) => {
    const r = workUnitManifestSchema.safeParse(m);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('accepts independent and dependent units', () => {
    expect(errors(manifest([unit('api'), unit('web', { dependsOn: ['api'] })]))).toEqual([]);
  });

  it('rejects duplicates, unknown or circular dependencies, and too many units', () => {
    expect(errors(manifest([unit('api'), unit('api')]))).toContain('Unit key "api" is used twice');
    expect(errors(manifest([unit('api', { dependsOn: ['nope'] })]))).toContain('Unit "api" depends on unknown unit "nope"');
    expect(errors(manifest([unit('api', { dependsOn: ['api'] })]))).toContain('Unit "api" depends on itself');
    expect(errors(manifest([unit('a', { dependsOn: ['b'] }), unit('b', { dependsOn: ['a'] })]))).toContain('The units depend on each other in a cycle');
    expect(errors(manifest(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((k) => unit(k)))).length).toBeGreaterThan(0);
    expect(errors({ ...manifest([unit('api')]), version: 2 }).length).toBeGreaterThan(0);
  });

  it('only takes repository-relative paths', () => {
    for (const bad of ['/etc/', '../outside/', 'a/../b', 'C:\\Windows', 'C:/x', '.git/hooks/', 'a//b', './a', 'a b', 'x;rm -rf', '$(id)', '']) {
      expect(pathPrefixSchema.safeParse(bad).success, bad).toBe(false);
    }
    for (const good of ['apps/dashboard/', 'packages/shared/src/schemas.ts', '.github/workflows/', 'README.md']) expect(pathPrefixSchema.safeParse(good).success, good).toBe(true);
  });

  it('decides ownership by whole path segments', () => {
    expect(pathInScope('apps/web/x.ts', ['apps/web/'])).toBe(true);
    expect(pathInScope('apps/web/x.ts', ['apps/web'])).toBe(true);
    expect(pathInScope('apps/webby/x.ts', ['apps/web/'])).toBe(false);
    expect(pathInScope('README.md', ['README.md'])).toBe(true);
    expect(pathInScope('README.md.bak', ['README.md'])).toBe(false);
    expect(scopesOverlap(['apps/'], ['apps/web/'])).toBe(true);
    expect(scopesOverlap(['apps/web/'], ['apps/webby/'])).toBe(false);
  });

  it('finds units that could run together and claim the same paths', () => {
    expect(independentOverlaps([unit('a', { pathPrefixes: ['shared/'] }), unit('b', { pathPrefixes: ['shared/x.ts'] })].map((u) => ({ dependsOn: [], ...u })))).toEqual([['a', 'b']]);
    // One after the other is not "at the same time".
    expect(independentOverlaps([unit('a', { pathPrefixes: ['shared/'] }), unit('b', { pathPrefixes: ['shared/'], dependsOn: ['a'] })].map((u) => ({ dependsOn: [], ...u })))).toEqual([]);
  });
});
