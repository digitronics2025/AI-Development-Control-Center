import { describe, expect, it } from 'vitest';
import { COMPLETE, validateWorkflow, type StageDefinition } from '@acc/shared';
import { withStageKind } from './WorkflowsPage';

// An agent stage like the Frontend Design profile's review (a pinned agent, a verdict team, instructions, a tool profile and skills).
const agentStage: StageDefinition = {
  key: 'review',
  name: 'Design review',
  role: 'reviewer',
  kind: 'agent',
  agentId: 'claude',
  model: 'opus',
  effort: 'high',
  permissionLevel: 1,
  timeoutSec: 1800,
  retry: { maxAttempts: 1 },
  requiresApproval: false,
  next: COMPLETE,
  verdict: true,
  optional: false,
  team: { mode: 'fixed', maxWorkers: 2, workers: [{ key: 'a', focus: 'Whole diff', primary: true }, { key: 'b', focus: 'States', primary: false }] },
  instructions: 'Review against the approved direction.',
  toolProfile: 'frontend-design',
  skills: ['tenten-web-design', 'design-review'],
};

const issuesOf = (stage: StageDefinition) => validateWorkflow({ id: 'custom', name: 'Custom', stages: [stage] }).issues;

describe('withStageKind', () => {
  it('drops the agent-only fields when a stage stops being an agent stage, so no hidden field blocks saving', () => {
    expect(issuesOf(agentStage)).toEqual([]);
    // Changing only the kind left six errors about fields the inspector no longer shows.
    expect(issuesOf({ ...agentStage, kind: 'tests' }).map((i) => i.field).sort()).toEqual(['agentId', 'instructions', 'skills', 'team', 'toolProfile', 'verdict']);
    for (const kind of ['tests', 'git', 'verify'] as const) {
      const next = withStageKind(agentStage, kind);
      expect(next.kind).toBe(kind);
      expect(issuesOf({ ...next, permissionLevel: kind === 'git' ? 3 : next.permissionLevel })).toEqual([]);
    }
    const command = withStageKind(agentStage, 'command');
    expect(command).toMatchObject({ agentId: undefined, model: undefined, effort: undefined, team: undefined, verdict: false, instructions: undefined, toolProfile: undefined, skills: undefined });
    // What stays is visible for a command stage and unrelated to the kind.
    expect(command).toMatchObject({ key: 'review', name: 'Design review', role: 'reviewer', permissionLevel: 1, timeoutSec: 1800, next: COMPLETE });
  });

  it('drops the command kinds when a system stage becomes an agent stage', () => {
    const tests: StageDefinition = { ...withStageKind(agentStage, 'tests'), commandKinds: ['lint', 'test'] };
    expect(issuesOf({ ...tests, kind: 'agent' }).map((i) => i.field)).toEqual(['commandKinds']);
    const agent = withStageKind(tests, 'agent');
    expect(agent.kind).toBe('agent');
    expect(agent.commandKinds).toBeUndefined();
    expect(issuesOf(agent)).toEqual([]);
  });

  it('leaves a stage alone when the kind does not change', () => {
    expect(withStageKind(agentStage, 'agent')).toBe(agentStage);
  });
});
