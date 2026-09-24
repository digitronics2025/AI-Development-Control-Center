import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import { PROMPT_PLACEHOLDERS, placeholdersIn, unknownPlaceholders } from '@acc/shared';
import { RUN_CONTEXT, renderTemplate } from '../src/engine/context.js';
import { SKILLS_PROMPT_SECTION } from '../src/engine/tooling.js';
import { addRepo, createTask, createTestApp, makeRepo, ROOT, waitForStatus, type TestApp } from './helpers.js';

const PROMPTS_DIR = path.join(ROOT, 'prompts');
const templates = Object.fromEntries(readdirSync(PROMPTS_DIR).map((f) => [f.replace(/\.md$/, ''), readFileSync(path.join(PROMPTS_DIR, f), 'utf8')]));
const WORK_ROLES = ['investigator', 'planner', 'implementer', 'fixer'];
const JUDGE_ROLES = ['reviewer', 'verifier'];

/**
 * The template-to-parser contract (docs/systems/prompts.md): what the built-in
 * templates promise the engine, the report and the Chairman can read.
 */
describe('built-in prompt templates', () => {
  it('cover the six agent roles and use only placeholders the builder fills', () => {
    expect(Object.keys(templates).sort()).toEqual(['fixer', 'implementer', 'investigator', 'planner', 'reviewer', 'verifier']);
    for (const [role, body] of Object.entries(templates)) {
      expect(unknownPlaceholders(body), `${role}.md`).toEqual([]);
      expect(placeholdersIn(body).length, `${role}.md uses placeholders`).toBeGreaterThan(5);
    }
  });

  it('keep the machine-read lines and the report shape every role must produce', () => {
    for (const role of WORK_ROLES) {
      expect(templates[role], role).toContain('BLOCKED ON OPERATOR: <the decision needed, the options, and your recommendation>');
      expect(templates[role], role).not.toContain('NEEDS OPERATOR');
    }
    for (const role of JUDGE_ROLES) {
      expect(templates[role], role).toContain('`VERDICT: PASS` or `VERDICT: FAIL`');
      expect(templates[role], role).toContain('NEEDS OPERATOR:');
      expect(templates[role], role).toContain('`CAUSE: code`');
      expect(templates[role], role).toContain('`CAUSE: plan`');
      expect(templates[role], role).not.toContain('BLOCKED ON OPERATOR');
    }
    for (const [role, body] of Object.entries(templates)) {
      // The timeline line is the first prose line under Summary, so it is the first heading asked for.
      const headings = [...body.matchAll(/- `## ([^`]+)`/g)].map((m) => m[1]);
      expect(headings[0], `${role} report starts with Summary`).toBe('Summary');
      expect(headings, `${role} names the skills it ran`).toContain('Skills used');
      // The Skills and Requested skills sections are appended by the engine; a template never repeats them.
      expect(body, role).not.toMatch(/^## (Skills|Requested skills)$/m);
      expect(body, role).not.toContain(SKILLS_PROMPT_SECTION.split('\n')[2]!);
    }
  });

  it('give each role the loop context it lacked', () => {
    for (const role of ['implementer', 'reviewer', 'fixer', 'verifier', 'investigator', 'planner']) {
      expect(templates[role], role).toContain('{{diff}}');
      expect(templates[role], role).toContain('{{test_results}}');
      expect(templates[role], role).toContain('{{review}}');
    }
    for (const role of ['investigator', 'planner', 'implementer']) expect(templates[role], role).toContain('{{attachments}}');
    for (const role of ['implementer', 'fixer']) expect(templates[role], role).toContain('{{verification_commands}}');
    for (const role of ['reviewer', 'verifier', 'fixer']) expect(templates[role], role).toContain('{{implementation_report}}');
    for (const role of ['reviewer', 'verifier', 'fixer']) expect(templates[role], role).toContain('{{verification_report}}');
    expect(templates.investigator).toContain('{{investigation}}');
    expect(templates.verifier).toContain("Repeat the review's `NEEDS OPERATOR:` items");
    expect(templates.planner).toContain('- `## Success Criteria`');
    expect(templates.planner).toContain('- `## Irreversible steps and approvals`');
  });

  it('render every placeholder and turn an empty or unknown one into "(none)"', () => {
    const vars = Object.fromEntries(Object.keys(PROMPT_PLACEHOLDERS).map((k) => [k, `<${k}>`]));
    for (const [role, body] of Object.entries(templates)) {
      const rendered = renderTemplate(body, vars);
      expect(rendered, role).not.toMatch(/\{\{/);
      expect(rendered, role).toContain('<request>');
    }
    expect(renderTemplate('a {{ plan }} b {{nope}} c {{diff}}', { plan: 'P', diff: '  ' })).toBe('a P b (none) c (none)');
  });

  it('states the output rules that hold for every template in RUN_CONTEXT', () => {
    expect(RUN_CONTEXT).toContain('Only your final message is kept');
    expect(RUN_CONTEXT).toContain('BLOCKED ON OPERATOR:, NEEDS OPERATOR:, CAUSE: and VERDICT:');
  });
});

describe('rendered stage prompts', () => {
  let t: TestApp;
  beforeEach(async () => {
    SimulatedAgentAdapter.reset();
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  /** The rendered prompt of the n-th run (1-based) of a stage, read from the artifact saved before the agent started. */
  const promptOf = (id: string, stageKey: string, run = 1) => {
    const stage = t.services.store.listStages(id).filter((s) => s.stageKey === stageKey)[run - 1];
    expect(stage, `${stageKey} run ${run}`).toBeDefined();
    const rec = t.services.store.listArtifacts(id).find((a) => a.stageId === stage!.id && a.name.includes('-prompt'));
    expect(rec, `prompt artifact of ${stageKey} run ${run}`).toBeDefined();
    return readFileSync(path.isAbsolute(rec!.path) ? rec!.path : path.join(t.dataDir, rec!.path), 'utf8');
  };

  it('are saved for every agent stage under the role name', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Add a greeting');
    expect((await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'])).status).toBe('COMPLETED');
    const names = t.services.store.listArtifacts(id).map((a) => a.name);
    for (const name of ['investigation-prompt.md', 'plan-prompt.md', 'implementation-prompt.md', 'review-prompt.md', 'verification-prompt.md']) expect(names).toContain(name);
    expect(promptOf(id, 'investigate')).toContain('stage "Investigate" of the "Normal Development" workflow');
    expect(promptOf(id, 'verify')).toContain('Fix cycles used so far: 0 of 3.');
  });

  it('show the fixer the review, the checks to run and the reports; show the second review its predecessor; show the verifier the reports', async () => {
    const repo = await makeRepo({ scripts: { test: 'node -e "console.log(\'3 passed\')"' } });
    const id = await createTask(t, await addRepo(t, repo), 'Fix it [sim:review-fail-once]');
    expect((await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'])).status).toBe('COMPLETED');
    const firstReview = readFileSync(path.join(t.dataDir, 'tasks', id, 'review.md'), 'utf8');
    expect(firstReview).toContain('VERDICT: FAIL');

    const fix = promptOf(id, 'fix');
    expect(fix).toContain('This is fix cycle 1 of 3');
    expect(fix).toContain('## Review findings to address\n\n' + firstReview.trim());
    expect(fix).toContain('## Checks the orchestrator runs after you finish\n\n- Unit tests: `npm test`');
    expect(fix).toContain('## Implementation and earlier fix reports\n\n## Changes');

    const secondReview = promptOf(id, 'review', 2);
    expect(secondReview).toContain('Fix cycles used so far: 1 of 3.');
    expect(secondReview).toContain('## Previous review\n\n' + firstReview.trim());
    expect(promptOf(id, 'review', 1)).toContain('## Previous review\n\n(none)');

    const verify = promptOf(id, 'verify');
    expect(verify).toContain('## Implementation and fix reports (claims to check, not evidence)\n\n### implementation-report.md');
    expect(verify).toContain('### fix-report.md');
    expect(verify).toContain('## Latest review\n\n## Review\n\nThe diff matches the plan.');
  });

  it('show the implementer what failed when a Quick Change test sends the task back to it', async () => {
    const repo = await makeRepo({ scripts: { test: 'node -e "console.log(\'expected a heading, got a list\'); process.exit(1)"' } });
    const id = await createTask(t, await addRepo(t, repo), 'Quick fix', { workflowId: 'quick-change', supervised: false });
    const task = await waitForStatus(t, id, ['WAITING_FOR_USER', 'COMPLETED', 'FAILED']);
    expect(task.blocker?.kind).toBe('fix_limit');
    expect(promptOf(id, 'implement', 1)).toContain('Latest test and build results:\n\n(none)');
    const second = promptOf(id, 'implement', 2);
    expect(second).toContain('Fix cycles used so far: 1 of 2.');
    expect(second).toContain('- unit tests: failed (exit 1)');
    expect(second).toContain('expected a heading, got a list');
    expect(second).toContain('## Approved plan\n\n(none)');
  });

  it('show a second investigator the first report', async () => {
    const id = await createTask(t, await addRepo(t, await makeRepo()), 'Look twice', { workflowId: 'deep-investigation' });
    expect((await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'])).status).toBe('COMPLETED');
    expect(promptOf(id, 'investigate')).toContain('## Earlier investigation\n\n(none)');
    const second = promptOf(id, 'second-opinion');
    expect(second).toContain('stage "Second investigation" of the "Deep Investigation" workflow');
    expect(second).toContain('## Earlier investigation\n\n## Findings\n\nThe repository at');
  });
});
