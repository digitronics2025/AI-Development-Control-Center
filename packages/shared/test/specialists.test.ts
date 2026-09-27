import { describe, expect, it } from 'vitest';
import { normalizeSpecialty, readableWorkUnits, routedStage, stageDefinitionSchema, validateWorkflow, type StageSpecialist, type WorkflowProfileInput } from '../src/index.js';

/** Specialists of an adaptive team (docs/plans/DESIGNER_ROUTING_PLAN.md §6). */

const designer: StageSpecialist = { specialty: 'frontend', description: 'Pages, layout, styling, UI components and images', role: 'designer', toolProfile: 'frontend-design', instructions: 'Build mode.' };

const workflow = (implement: Record<string, unknown>): WorkflowProfileInput =>
  ({
    id: 'custom',
    name: 'Custom',
    stages: [
      { key: 'plan', name: 'Plan', role: 'planner', permissionLevel: 1, next: 'implement' },
      { key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, next: 'complete', team: { mode: 'adaptive', maxWorkers: 3, specialists: [designer] }, ...implement },
    ],
  }) as WorkflowProfileInput;
const issues = (implement: Record<string, unknown>) => validateWorkflow(workflow(implement)).issues.map((i) => `${i.field}: ${i.message}`);

describe('where specialists may stand', () => {
  it('accepts them on a Level 2 adaptive write stage', () => {
    expect(issues({})).toEqual([]);
  });

  it('refuses them on a fixed team, a Fix, a read-only or a Level 3 stage, and a non-writing specialist', () => {
    expect(issues({ team: { mode: 'fixed', maxWorkers: 2, workers: [{ key: 'a', focus: 'a' }, { key: 'b', focus: 'b' }], specialists: [designer] }, permissionLevel: 1, role: 'investigator' }).join('\n')).toMatch(/Only an adaptive team/);
    expect(issues({ role: 'fixer' }).join('\n')).toMatch(/A Fix splits its own work/);
    expect(issues({ permissionLevel: 3 }).join('\n')).toMatch(/only a Level 2 stage that writes code/);
    expect(issues({ role: 'investigator', permissionLevel: 1 }).join('\n')).toMatch(/only a Level 2 stage that writes code/);
    const critic = { ...designer, role: 'visual-critic' };
    expect(issues({ team: { mode: 'adaptive', maxWorkers: 3, specialists: [critic] } })).toEqual(['team.specialists.0.role: A specialist writes code: choose a role that changes files (designer, implementer)']);
    expect(issues({ team: { mode: 'adaptive', maxWorkers: 3, specialists: [designer, designer] } })).toEqual(['team.specialists.1.specialty: Specialty "frontend" is listed twice']);
  });
});

describe('routedStage', () => {
  it("keeps the stage's key, level, transitions and agent pin; takes the specialist's role, instructions and tools only", () => {
    const stage = stageDefinitionSchema.parse({ key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, timeoutSec: 3600, retry: { maxAttempts: 2 }, next: 'test', agentId: 'claude', instructions: 'Implementer only.', skills: ['ship-it'], team: { mode: 'adaptive', maxWorkers: 3, specialists: [designer] } });
    const routed = routedStage(stage, designer);
    expect(routed).toMatchObject({ key: 'implement', name: 'Implement', role: 'designer', permissionLevel: 2, timeoutSec: 3600, retry: { maxAttempts: 2 }, next: 'test', agentId: 'claude', instructions: 'Build mode.', toolProfile: 'frontend-design', verdict: false });
    expect(routed.team).toBeUndefined();
    expect(routed.skills).toBeUndefined();
    expect(routedStage(stage, { ...designer, toolProfile: undefined }).toolProfile).toBeUndefined();
  });
});

describe('normalizeSpecialty', () => {
  it('reads a label as a key', () => {
    expect(normalizeSpecialty('Frontend')).toBe('frontend');
    expect(normalizeSpecialty(' front end ')).toBe('front-end');
    expect(normalizeSpecialty('!!!')).toBeNull();
    expect(normalizeSpecialty(undefined)).toBeNull();
  });
});

describe('readableWorkUnits', () => {
  it("shows a plan's work units as a list that names who does each one", () => {
    const plan = [
      '## Implementation Plan',
      '',
      '```acc-work-units',
      JSON.stringify({ version: 1, stage: 'implement', units: [
        { key: 'api', title: 'API handler', goal: 'x', dependsOn: [], pathPrefixes: ['src/api/'] },
        { key: 'card', title: 'Card component', goal: 'y', specialty: 'Frontend', dependsOn: ['api'], pathPrefixes: ['src/components/'] },
      ] }),
      '```',
    ].join('\n');
    const roleOf = (stage: string, specialty: string | null) => (stage === 'implement' && specialty === 'frontend' ? 'designer' : null);
    const text = readableWorkUnits(plan, roleOf);
    expect(text).not.toContain('acc-work-units');
    expect(text).toContain('**Work units for implement:**');
    expect(text).toContain('- **API handler** (`src/api/`)');
    // Mixed work reaches the designer only when that unit runs as its own unit: said so, not promised.
    expect(text).toContain('- **Card component** — frontend work: the designer when it runs as its own unit, after `api` (`src/components/`)');
    // Each unit's goal is shown: it is what the worker is told.
    expect(text).toContain('  y');
    // A plan that is all one specialist's work is that specialist's.
    const whole = readableWorkUnits(['```acc-work-units', JSON.stringify({ version: 1, stage: 'implement', units: [{ key: 'card', title: 'Card', goal: 'Restyle the card', specialty: 'frontend', pathPrefixes: ['src/__tests__/'] }] }), '```'].join('\n'), roleOf);
    expect(whole).toContain('- **Card** — by the designer (`src/__tests__/`)');
    expect(whole).toContain('  Restyle the card');
  });

  it('reads a block as the orchestrator does (keys folded, unknown checks dropped) and keeps Markdown in titles literal', () => {
    const plan = ['```acc-work-units', JSON.stringify({ version: 1, stage: 'implement', units: [{ key: 'API_discount', title: 'Fix __init__ loader', goal: 'Load *once*', checks: ['node --test'], pathPrefixes: ['src/'] }] }), '```'].join('\n');
    const text = readableWorkUnits(plan, () => null);
    expect(text).toContain('- **Fix \\_\\_init\\_\\_ loader** (`src/`)');
    expect(text).toContain('  Load \\*once\\*');
  });

  it('leaves a block it cannot read as written', () => {
    const plan = '```acc-work-units\n{"version": 2}\n```';
    expect(readableWorkUnits(plan, () => null)).toBe(plan);
    expect(readableWorkUnits('```acc-work-units\nnot json\n```', () => null)).toContain('not json');
  });
});
