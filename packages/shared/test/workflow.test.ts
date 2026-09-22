import { describe, expect, it } from 'vitest';
import { resolveAssignment, validateWorkflow, workflowPath, type StageDefinitionInput } from '../src/index.js';

const stage = (s: Partial<StageDefinitionInput> & { key: string; next: string }): StageDefinitionInput => ({
  name: s.key,
  role: 'implementer',
  ...s,
});

const normal = {
  id: 'normal',
  name: 'Normal',
  stages: [
    stage({ key: 'investigate', role: 'investigator', next: 'implement' }),
    stage({ key: 'implement', next: 'test', permissionLevel: 2 }),
    stage({ key: 'test', role: 'tester', kind: 'tests', next: 'review', onFail: 'fix', permissionLevel: 2 }),
    stage({ key: 'review', role: 'reviewer', next: 'complete', onFail: 'fix', verdict: true }),
    stage({ key: 'fix', role: 'fixer', next: 'test', permissionLevel: 2 }),
  ],
};

describe('validateWorkflow', () => {
  it('accepts a workflow whose loop goes through onFail', () => {
    const { profile, issues } = validateWorkflow(normal);
    expect(issues).toEqual([]);
    expect(profile?.maxFixCycles).toBe(3);
  });

  it('rejects unknown transition targets', () => {
    const bad = { ...normal, stages: normal.stages.map((s) => (s.key === 'review' ? { ...s, next: 'nowhere' } : s)) };
    const { issues } = validateWorkflow(bad);
    expect(issues).toContainEqual(expect.objectContaining({ stageIndex: 3, field: 'next' }));
  });

  it('rejects a next-only cycle', () => {
    const bad = {
      id: 'loop',
      name: 'Loop',
      stages: [stage({ key: 'a', next: 'b' }), stage({ key: 'b', next: 'a' })],
    };
    const { issues } = validateWorkflow(bad);
    expect(issues.some((i) => i.message.includes('loop'))).toBe(true);
  });

  it('rejects unreachable stages and duplicate keys', () => {
    const unreachable = { id: 'x', name: 'X', stages: [stage({ key: 'a', next: 'complete' }), stage({ key: 'b', next: 'complete' })] };
    expect(validateWorkflow(unreachable).issues).toContainEqual(expect.objectContaining({ stageIndex: 1 }));
    const dup = { id: 'x', name: 'X', stages: [stage({ key: 'a', next: 'complete' }), stage({ key: 'a', next: 'complete' })] };
    expect(validateWorkflow(dup).issues[0]?.message).toMatch(/twice/);
  });

  it('maps schema errors to stage fields', () => {
    const { issues } = validateWorkflow({ id: 'x', name: 'X', stages: [{ key: 'Bad Key', name: 'a', role: 'nope', next: 'complete' }] });
    expect(issues.some((i) => i.stageIndex === 0 && i.field === 'key')).toBe(true);
    expect(issues.some((i) => i.stageIndex === 0 && i.field === 'role')).toBe(true);
  });

  it('rejects onFail on a stage without a verdict', () => {
    const bad = { ...normal, stages: normal.stages.map((s) => (s.key === 'implement' ? { ...s, onFail: 'fix' } : s)) };
    expect(validateWorkflow(bad).issues).toContainEqual(expect.objectContaining({ stageIndex: 1, field: 'onFail' }));
  });
});

describe('workflowPath', () => {
  it('follows next and appends off-path stages', () => {
    const { profile } = validateWorkflow(normal);
    expect(workflowPath(profile!).map((s) => s.key)).toEqual(['investigate', 'implement', 'test', 'review', 'fix']);
  });
});

describe('resolveAssignment', () => {
  const { profile } = validateWorkflow(normal);
  const implement = profile!.stages[1]!;

  it('applies global → repository → task role → task stage precedence', () => {
    const layers = {
      roleDefaults: { implementer: { agentId: 'claude', model: 'sonnet', effort: 'medium' } },
      repositoryOverrides: { implementer: { effort: 'high' } },
      taskOverrides: { roles: {}, stages: {} },
    };
    expect(resolveAssignment(implement, layers)).toEqual({ agentId: 'claude', model: 'sonnet', effort: 'high' });
    layers.taskOverrides = { roles: { implementer: { agentId: 'codex', effort: 'high' } }, stages: {} } as never;
    expect(resolveAssignment(implement, layers)).toEqual({ agentId: 'codex', model: 'default', effort: 'high' });
    layers.taskOverrides = { roles: {}, stages: { implement: { model: 'opus' } } } as never;
    expect(resolveAssignment(implement, layers)).toEqual({ agentId: 'claude', model: 'opus', effort: 'high' });
  });
});
