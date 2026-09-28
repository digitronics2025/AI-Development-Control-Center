import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import { addRepo, createTask, createTestApp, makeRepo, waitForStatus, type TestApp } from './helpers.js';

/** Full Autopilot's Implement sends the plan's frontend work to the designer (docs/plans/DESIGNER_ROUTING_PLAN.md §6). */

let t: TestApp;
beforeEach(async () => {
  SimulatedAgentAdapter.reset();
  t = await createTestApp();
});
afterEach(async () => {
  await t.close();
});

async function artifact(taskId: string, name: string): Promise<string> {
  const rec = t.services.store.listArtifacts(taskId).filter((a) => a.name === name).at(-1);
  if (!rec) throw new Error(`no artifact ${name}; have ${t.services.store.listArtifacts(taskId).map((a) => a.name).join(', ')}`);
  return (await t.services.artifacts.read(rec, 2_000_000)).content;
}

const implement = (id: string) => t.services.store.listStages(id).filter((s) => s.stageKey === 'implement');
const teamEvents = (id: string) => t.services.store.listEvents(id, { limit: 500 }).filter((e) => e.type === 'STAGE_TEAM').map((e) => e.message);

describe('Full Autopilot: specialists in Implement', () => {
  it("runs a plan that is all frontend work as the designer, on the stage's own agent", async () => {
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'Restyle the card [sim:plan-frontend]', { workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 120_000);
    expect(done.status).toBe('COMPLETED');

    const [stage] = implement(id);
    expect(stage).toMatchObject({ role: 'implementer', routedRole: 'designer', status: 'SUCCESS' });
    // The agent is the stage's own: a specialist changes what the worker is told, never who runs it.
    expect(stage!.agentId).toBe(t.services.views.assignmentFor(done, done.workflow.stages.find((s) => s.key === 'implement')!).agentId);
    expect(teamEvents(id)).toEqual(expect.arrayContaining(['Implement runs as one agent: the plan has only one work unit, so one agent does it', "Implement runs as the designer: the plan's work is frontend work"]));

    // The designer's template and the Autopilot instructions; the stage's own artifact names.
    const prompt = await artifact(id, 'implementation-prompt.md');
    expect(prompt).toMatch(/^Role: designer$/m);
    expect(prompt).toContain('You are the **Designer**');
    expect(prompt).toContain('Build mode inside Full Autopilot');
    expect(prompt).not.toContain('Implementer only');
    expect(await artifact(id, 'implementation-report.md')).toContain('Simulated designer run');
    // The designer's own usage is recorded under its role.
    const roles = t.services.store.db.prepare("SELECT agent_role FROM usage_events WHERE task_id = ? AND workflow_step = 'implement'").all(id) as Array<{ agent_role: string }>;
    expect(roles.map((r) => r.agent_role)).toContain('designer');
  }, 150_000);

  it('sends a labelled unit of a team to the designer and the others to the implementer', async () => {
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'Two parts [sim:team] [sim:team-frontend]', { workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 150_000);
    expect(done.status).toBe('COMPLETED');

    const [stage] = implement(id);
    expect(stage!.routedRole ?? null).toBeNull();
    const units = t.services.store.listWorkUnits(id, stage!.id).filter((u) => u.kind === 'worker');
    expect(units.map((u) => [u.unitKey, u.role, u.specialty])).toEqual([
      ['alpha', 'designer', 'frontend'],
      ['beta', null, null],
    ]);
    // Same agent for both: only the role differs.
    expect(new Set(units.map((u) => u.agentId)).size).toBe(1);
    expect(await artifact(id, 'implementation-prompt-alpha.md')).toMatch(/^Role: designer$/m);
    expect(await artifact(id, 'implementation-prompt-alpha.md')).toContain('You do it as the Designer (specialty: frontend)');
    expect(await artifact(id, 'implementation-prompt-beta.md')).toMatch(/^Role: implementer$/m);
  }, 180_000);

  it('keeps mixed work that cannot run in parallel with the implementer, and says why', async () => {
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'API and card [sim:plan-mixed]', { workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 120_000);
    expect(done.status).toBe('COMPLETED');
    expect(implement(id)[0]!.routedRole ?? null).toBeNull();
    expect(teamEvents(id)).toContain('Implement runs as the implementer: its work units need different specialists and cannot run in parallel');
    expect(await artifact(id, 'implementation-prompt.md')).toMatch(/^Role: implementer$/m);
  }, 150_000);

  it('never guesses at a label the stage has no specialist for', async () => {
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'Two parts [sim:team] [sim:team-unknown-label]', { workflowId: 'full-autopilot' });
    const done = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 150_000);
    expect(done.status).toBe('COMPLETED');
    expect(teamEvents(id)).toContain('Implement: Alpha part ("ui") is labelled with a specialty this stage does not have; the implementer does it');
    const units = t.services.store.listWorkUnits(id).filter((u) => u.stageKey === 'implement' && u.kind === 'worker');
    expect(units.map((u) => [u.unitKey, u.role, u.specialty])).toEqual([
      ['alpha', null, 'ui'],
      ['beta', null, null],
    ]);
  }, 180_000);

  it('gives two specialists that share a role each their own instructions, and routes one agent only for one specialty', async () => {
    // A copy of Full Autopilot whose Implement has a second designer specialty with other instructions.
    const base = (await t.api('GET', '/api/workflows/full-autopilot')).body;
    const stages = base.stages.map((s: { key: string; team?: { specialists?: unknown[] } }) =>
      s.key === 'implement'
        ? { ...s, team: { ...s.team, specialists: [...(s.team?.specialists ?? []), { specialty: 'email', description: 'Email templates', role: 'designer', instructions: 'Email rules: tables, inline styles.' }] } }
        : s,
    );
    expect((await t.api('PUT', '/api/workflows/two-designers', { ...base, id: 'two-designers', name: 'Two designers', builtin: false, stages })).status).toBe(200);
    const repo = await addRepo(t, await makeRepo());
    const team = await createTask(t, repo, 'Two parts [sim:team] [sim:team-frontend] [sim:team-email]', { workflowId: 'two-designers' });
    expect((await waitForStatus(t, team, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 150_000)).status).toBe('COMPLETED');
    const alpha = await artifact(team, 'implementation-prompt-alpha.md');
    const beta = await artifact(team, 'implementation-prompt-beta.md');
    expect(alpha).toContain('Build mode inside Full Autopilot');
    expect(alpha).not.toContain('Email rules');
    expect(beta).toContain('Email rules: tables, inline styles.');
    expect(beta).not.toContain('Build mode inside Full Autopilot');
    // A chain of a frontend and an email unit is two specialties: one agent, in the stage's own role.
    const chain = await createTask(t, repo, 'Chain [sim:team] [sim:team-chain] [sim:team-frontend] [sim:team-email]', { workflowId: 'two-designers' });
    expect((await waitForStatus(t, chain, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 150_000)).status).toBe('COMPLETED');
    expect(implement(chain)[0]!.routedRole ?? null).toBeNull();
    expect(teamEvents(chain)).toContain('Implement runs as the implementer: its work units need different specialists and cannot run in parallel');
  }, 360_000);

  it('tells the planner which specialties Implement has', async () => {
    const repo = await addRepo(t, await makeRepo());
    const id = await createTask(t, repo, 'Plain change', { workflowId: 'full-autopilot' });
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 120_000);
    const plan = await artifact(id, 'plan-prompt.md');
    expect(plan).toContain('- `implement` (Implement): up to 3 workers, each changing only the paths its unit owns. Specialties: `frontend` → Designer (Pages, layout, styling, UI components and images); any other unit → Implementer');
    expect(plan).toContain("Specialties: set a unit's `specialty` to the listed name");
  }, 150_000);
});
