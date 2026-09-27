import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SimulatedAgentAdapter } from '@acc/agent-sdk';
import { git } from '@acc/git';
import { PROMPT_PLACEHOLDERS, placeholdersIn, unknownPlaceholders, type CommandKind, type TestRun } from '@acc/shared';
import { RUN_CONTEXT, renderTemplate } from '../src/engine/context.js';
import { SKILLS_PROMPT_SECTION } from '../src/engine/tooling.js';
import { addRepo, createTask, createTestApp, makeRepo, ROOT, waitFor, waitForStatus, type TestApp } from './helpers.js';

const PROMPTS_DIR = path.join(ROOT, 'prompts');
const templates = Object.fromEntries(readdirSync(PROMPTS_DIR).map((f) => [f.replace(/\.md$/, ''), readFileSync(path.join(PROMPTS_DIR, f), 'utf8')]));
const WORK_ROLES = ['investigator', 'planner', 'implementer', 'fixer', 'designer', 'art-director'];
const JUDGE_ROLES = ['reviewer', 'verifier', 'visual-critic'];

/**
 * The template-to-parser contract (docs/systems/prompts.md): what the built-in
 * templates promise the engine, the report and the Chairman can read.
 */
describe('built-in prompt templates', () => {
  it('cover the nine agent roles and use only placeholders the builder fills', () => {
    expect(Object.keys(templates).sort()).toEqual(['art-director', 'designer', 'fixer', 'implementer', 'investigator', 'planner', 'reviewer', 'verifier', 'visual-critic']);
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
    for (const role of ['implementer', 'reviewer', 'fixer', 'verifier', 'investigator', 'planner', 'designer', 'art-director', 'visual-critic']) {
      expect(templates[role], role).toContain('{{diff}}');
      expect(templates[role], role).toContain('{{test_results}}');
      expect(templates[role], role).toContain('{{review}}');
    }
    for (const role of ['investigator', 'planner', 'implementer', 'designer', 'reviewer', 'verifier']) expect(templates[role], role).toContain('{{attachments}}');
    // Pictures are evidence for visual work: the designer, reviewer and verifier see what the Control Center captured.
    for (const role of ['designer', 'reviewer', 'verifier', 'visual-critic', 'art-director']) expect(templates[role], role).toContain('{{screenshots}}');
    for (const role of ['designer', 'art-director', 'visual-critic']) expect(templates[role], role).toContain('{{design_context}}');
    // The art direction is what the Assets stage spends against: it must state a budget and an asset list.
    expect(templates['art-director']).toContain('- `## Media budget`');
    expect(templates['art-director']).toContain('- `## Asset list`');
    expect(templates['art-director']).toContain('- `## Success Criteria`');
    for (const role of ['implementer', 'fixer', 'designer']) expect(templates[role], role).toContain('{{verification_commands}}');
    for (const role of ['reviewer', 'verifier', 'fixer', 'designer']) expect(templates[role], role).toContain('{{implementation_report}}');
    for (const role of ['reviewer', 'verifier', 'fixer', 'designer']) expect(templates[role], role).toContain('{{verification_report}}');
    // The designer's two modes, and the rules that keep a paid or committing action out of the wrong stage.
    expect(templates.designer).toContain('**`Stage: assets`**');
    expect(templates.designer).toContain('You never call a paid generation tool here');
    expect(templates.designer).toContain('**Never commit, push or deploy**');
    expect(templates.designer).toContain('- `## Spend`');
    expect(templates.designer).toContain('- `## Visual verification`');
    expect(templates.investigator).toContain('{{investigation}}');
    expect(templates.verifier).toContain("Repeat the review's `NEEDS OPERATOR:` items");
    expect(templates.planner).toContain('- `## Success Criteria`');
    expect(templates.planner).toContain('- `## Irreversible steps and approvals`');
  });

  it('leave full runs of a slow check to the Test stage instead of ordering or waiting for one', () => {
    for (const role of ['implementer', 'fixer', 'planner']) {
      expect(templates[role], role).toContain('## What each check costs here\n\n{{check_costs}}');
      expect(templates[role], role).toContain('"What each check costs here"');
      expect(templates[role], role).toMatch(/never (tells it to )?wait for another run/);
      expect(templates[role], role).toContain('Test stage only');
    }
    // TASK-0009's plan ordered the implementer to run the configured checks and wait for other runs.
    expect(templates.planner).not.toContain('the checks above plus');
    for (const role of ['implementer', 'fixer']) expect(templates[role], role).not.toContain('The orchestrator runs the full configured checks after this stage');
    // Level 1 stages may have no shell (docs/systems/agents.md): they read Git through the tools and run nothing.
    for (const role of ['investigator', 'planner']) expect(templates[role], role).toContain('do not run tests, builds or installs');
    expect(templates.investigator).not.toContain('the read-only Git commands');
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

  it("give the designer the repository's design standard and the reviewer the screenshots kept so far", async () => {
    const repoPath = await makeRepo({ files: { 'design.md': '# Design standard\n\nSemantic tokens only.\n' } });
    mkdirSync(path.join(repoPath, 'design'), { recursive: true });
    writeFileSync(path.join(repoPath, 'design', 'brief.md'), 'Audience: shoppers in Casablanca. Brand words: calm, precise, warm.\n');
    writeFileSync(path.join(repoPath, 'design', 'tokens.css'), ':root { --color-accent: #0a7; }\n');
    for (const args of [['add', '.'], ['commit', '-m', 'design memory']]) expect((await git(repoPath, args)).code).toBe(0);
    t.services.workflows.save('design-context', {
      name: 'Design context',
      maxFixCycles: 0,
      stages: [
        { key: 'build', name: 'Build', role: 'designer', permissionLevel: 2, next: 'review' },
        { key: 'review', name: 'Design review', role: 'reviewer', permissionLevel: 1, verdict: true, next: 'complete' },
      ],
    });
    const id = await createTask(t, await addRepo(t, repoPath), 'Restyle the landing page [sim:slow]', { workflowId: 'design-context' });
    await waitFor(() => t.services.store.latestStage(id, 'build'), (s) => s?.status === 'RUNNING', 30_000);
    // A capture made while the designer works (as the browser tools keep them).
    await t.services.artifacts.write(id, { name: 'landing-phone-dark.png', type: 'screenshot', content: Buffer.from('89504e470d0a1a0a', 'hex'), stageKey: 'build' });
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    const design = promptOf(id, 'build');
    expect(design).toMatch(/- design\.md \(1 KB\): the repository's design standard: read it in full before designing/);
    expect(design).toContain('- design/tokens.css (1 KB): design memory');
    expect(design).toContain('### design/brief.md\n\nAudience: shoppers in Casablanca. Brand words: calm, precise, warm.');
    // The designer keeps that memory for the next design task.
    expect(design).toMatch(/Keep the design memory\.\*\* When the repository has a `design\/` folder.+`design\/brief\.md`/);
    const review = promptOf(id, 'review');
    expect(review).toMatch(/- landing-phone-dark\.png \(screenshot, stage build, 1 KB\): .+landing-phone-dark\.png/);
  }, 90_000);

  it('never read design memory through a link that leaves the repository', async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'acc-outside-'));
    writeFileSync(path.join(outside, 'brief.md'), 'Private notes from another folder.\n');
    const repoPath = await makeRepo();
    symlinkSync(outside, path.join(repoPath, 'design'), 'dir');
    for (const args of [['add', 'design'], ['commit', '-m', 'design link']]) expect((await git(repoPath, args)).code).toBe(0);
    t.services.workflows.save('design-link', {
      name: 'Design link',
      maxFixCycles: 0,
      stages: [{ key: 'build', name: 'Build', role: 'designer', permissionLevel: 2, next: 'complete' }],
    });
    const id = await createTask(t, await addRepo(t, repoPath), 'Restyle the landing page', { workflowId: 'design-link' });
    await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'], 60_000);
    const design = promptOf(id, 'build');
    expect(design).not.toContain('Private notes from another folder');
    expect(design).not.toContain('design/brief.md (');
  }, 90_000);

  it('are saved for every agent stage under the role name', async () => {
    const repoPath = await makeRepo();
    const id = await createTask(t, await addRepo(t, repoPath), 'Add a greeting');
    const task = await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
    expect(task.status).toBe('COMPLETED');
    const names = t.services.store.listArtifacts(id).map((a) => a.name);
    for (const name of ['investigation-prompt.md', 'plan-prompt.md', 'implementation-prompt.md', 'review-prompt.md', 'verification-prompt.md']) expect(names).toContain(name);
    expect(promptOf(id, 'investigate')).toContain('stage "Investigate" of the "Normal Development" workflow');
    expect(promptOf(id, 'verify')).toContain('Fix cycles used so far: 0 of 3.');
    // An isolated task's agents are pointed at its worktree, never at the operator's checkout.
    expect(task.git.isolated).toBe(true);
    const implement = promptOf(id, 'implement');
    const workdir = /^Working directory: (.+)$/m.exec(implement)?.[1];
    expect(workdir).toBeDefined();
    expect(workdir).not.toBe(repoPath);
    expect(implement).toContain(`- Path: ${workdir}\n`);
    expect(implement).not.toContain(`- Path: ${repoPath}\n`);
  });

  it('show the fixer the review, the checks to run and the reports; show the second review its predecessor; show the verifier the reports', async () => {
    const repo = await makeRepo({ scripts: { test: 'node -e "console.log(\'3 passed\')"' } });
    const id = await createTask(t, await addRepo(t, repo), 'Fix it [sim:review-fail-once]');
    expect((await waitForStatus(t, id, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER'])).status).toBe('COMPLETED');
    const firstReview = readFileSync(path.join(t.dataDir, 'tasks', id, 'review.md'), 'utf8');
    expect(firstReview).toContain('VERDICT: FAIL');
    // A single reviewer's FAIL carries its duration, as a completion would.
    const failed = t.services.store.listEvents(id, { limit: 1000 }).find((e) => e.type === 'REVIEW_FAILED')!;
    expect(failed.message).toBe('Review requested changes');
    expect(typeof failed.data.durationMs).toBe('number');

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

describe('check costs', () => {
  let t: TestApp;
  let seq = 0;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const MIN = 60_000;
  /** A finished run of `command`, `ago` minutes before now. */
  const run = (taskId: string, kind: CommandKind, command: string, durationMs: number, ago: number, extra: Partial<TestRun> = {}): TestRun => {
    const finishedAt = new Date(Date.now() - ago * MIN).toISOString();
    return { id: `run-${++seq}`, taskId, stageId: null, executionId: null, name: kind, kind, command, status: 'passed', exitCode: 0, durationMs, summary: null, startedAt: finishedAt, finishedAt, ...extra };
  };
  /** The prompt a stage of a task that has not started would get now. */
  const promptFor = async (taskId: string, stageKey: string) => {
    const task = t.services.store.getTask(taskId)!;
    const def = task.workflow.stages.find((s) => s.key === stageKey)!;
    return (await t.services.context.build(task, def, { id: 'x', createdAt: new Date().toISOString() } as never)).prompt;
  };

  it("tell the implementer, fixer and planner to leave a suite the repository's records show is slow to the Test stage", async () => {
    const scripts = { lint: 'node -e "0"', test: 'node -e "0"', build: 'node -e "0"', 'test:e2e': 'node -e "0"' };
    const repo = await addRepo(t, await makeRepo({ scripts }));
    const other = await addRepo(t, await makeRepo());
    const earlier = await createTask(t, repo, 'Earlier work', { start: false });
    const current = await createTask(t, repo, 'Add a report', { start: false });
    const elsewhere = await createTask(t, other, 'Other repository', { start: false });
    const runs = [
      run(earlier, 'test', 'npm test', 14 * MIN, 50),
      run(earlier, 'test', 'npm test', 22 * MIN, 40),
      run(earlier, 'test', 'npm test', 18 * MIN, 30),
      // The suite ran to its end and failed only where the baseline already did: it counts.
      run(earlier, 'test', 'npm test', 20 * MIN, 20, { status: 'failed', exitCode: 1, classification: 'preexisting' }),
      // None of these timed the whole command.
      run(earlier, 'test', 'npm test', 5_000, 10, { selection: 'changed' }),
      run(earlier, 'test', 'npx vitest run src/a.test.ts', 3_000, 9),
      run(earlier, 'test', 'npm test', 1_000, 8, { reusedFrom: 'run-1' }),
      run(earlier, 'test', 'npm test', 2_000, 7, { status: 'failed', exitCode: 1, classification: 'new' }),
      run(earlier, 'lint', 'npm run lint', 30_000, 30),
      run(earlier, 'lint', 'npm run lint', 40_000, 20),
      // Another repository's suite with the same command line is not this one's.
      ...[1, 2, 3].map((ago) => run(elsewhere, 'test', 'npm test', 4_000, ago)),
    ];
    for (const r of runs) t.services.store.insertTestRun(r);

    const implement = await promptFor(current, 'implement');
    expect(implement).toContain('## What each check costs here\n\nTypical duration of each configured check in this repository');
    expect(implement).toContain('- Unit tests `npm test`: about 19 min (median of 4 recent runs) — **slow**\n');
    expect(implement).toContain('- Lint `npm run lint`: about 35 s (median of 2 recent runs)\n');
    expect(implement).toContain('- Build `npm run build`: not timed yet\n');
    // Normal Development's Test stage does not run end-to-end suites.
    expect(implement).toContain('- End-to-end tests `npm run test:e2e`: not timed yet — **Test stage only** — no later stage of this task runs it\n');
    expect(implement).toContain('**Slow here (typically over 2 minutes): Unit tests.** Do not run a slow check in full, and do not start or wait for another run of one');
    expect(implement).toContain('Every other check above apart from the end-to-end tests is quick here or not timed yet: running it in full is fine.');
    expect(implement).toContain('**End-to-end tests are left to the Test stage, however quick they are.** Do not run the end-to-end command yourself, in full or for a single spec file');
    for (const stage of ['fix', 'plan']) expect(await promptFor(current, stage), stage).toContain('**Slow here (typically over 2 minutes): Unit tests.**');

    // Full Autopilot's Test stage runs them.
    const thorough = await createTask(t, repo, 'Add a chart', { start: false, workflowId: 'full-autopilot' });
    expect(await promptFor(thorough, 'implement')).toContain('- End-to-end tests `npm run test:e2e`: not timed yet — **Test stage only**\n');

    // Across repositories each folder's commands carry that repository's own history.
    const both = await createTask(t, repo, 'Report in both', { start: false, linkedRepositoryIds: [other] });
    const [primary, linked] = [t.services.store.getTask(both)!.git.folder, t.services.store.listLinkedRepositories(both)[0]!.folder];
    const workspace = await promptFor(both, 'implement');
    expect(workspace).toContain(`- ${primary}/ Unit tests \`npm test\`: about 19 min (median of 4 recent runs) — **slow**\n`);
    expect(workspace).toContain(`- ${linked}/ Unit tests \`npm test\`: about 4 s (median of 3 recent runs)\n`);
    expect(workspace).toContain(`**Slow here (typically over 2 minutes): ${primary}/ Unit tests.**`);
    expect(workspace).toContain(`**End-to-end tests are left to the Test stage, however quick they are (${primary}/ End-to-end tests).**`);
  });

  it('say running the checks is fine when every one is fast or none has been timed, and render nothing without checks', async () => {
    const repo = await addRepo(t, await makeRepo({ scripts: { lint: 'node -e "0"', test: 'node -e "0"' } }));
    const id = await createTask(t, repo, 'Add a heading', { start: false });
    const untimed = await promptFor(id, 'implement');
    expect(untimed).toContain('- Unit tests `npm test`: not timed yet\n');
    expect(untimed).toContain('None of them has been timed in this repository yet, so running them in full is fine.');
    expect(untimed).not.toContain('Slow here');

    t.services.store.insertTestRun(run(id, 'test', 'npm test', 40_000, 5));
    t.services.store.insertTestRun(run(id, 'lint', 'npm run lint', 110_000, 5));
    const fast = await promptFor(id, 'implement');
    expect(fast).toContain('- Unit tests `npm test`: about 40 s (median of 1 recent run)\n');
    expect(fast).toContain('- Lint `npm run lint`: about 1.8 min (median of 1 recent run)\n');
    expect(fast).toContain('None is slow here (each typically takes under 2 minutes, or has not been timed yet): running them in full is fine');
    expect(fast).not.toContain('Slow here');

    const bare = await createTask(t, await addRepo(t, await makeRepo({ noPackageJson: true })), 'Write notes', { start: false });
    expect(await promptFor(bare, 'implement')).toContain('## What each check costs here\n\n(none)\n');

    // A template edited in Settings without the placeholder still gets the block; a reviewer runs no checks and does not.
    expect((await t.api('PUT', '/api/prompts/implementer', { body: 'Implement {{request}}' })).status).toBe(200);
    expect(await promptFor(id, 'implement')).toMatch(/^Implement # .+\n\n.+\n\n## What each check costs here\n\nTypical duration of each configured check/m);
    expect(await promptFor(id, 'review')).not.toContain('## What each check costs here');
    expect(await promptFor(bare, 'implement')).not.toContain('## What each check costs here');
  });

  it('never tell an agent to run end-to-end tests, however quick they are', async () => {
    // tenten-accounting-in's e2e suite takes about two minutes on a fixed port with a reused server (TASK-0014).
    const repo = await addRepo(t, await makeRepo({ scripts: { lint: 'node -e "0"', 'test:e2e': 'node -e "0"' } }));
    const id = await createTask(t, repo, 'Add a button', { start: false, workflowId: 'full-autopilot' });
    const fine = /None is slow here|None of them has been timed|Every other check above is quick/;
    const untimed = await promptFor(id, 'implement');
    expect(untimed).toContain('- End-to-end tests `npm run test:e2e`: not timed yet — **Test stage only**\n');
    expect(untimed).toContain('The checks above other than the end-to-end tests have not been timed in this repository yet, so running them in full is fine.');
    expect(untimed).not.toMatch(fine);

    t.services.store.insertTestRun(run(id, 'e2e', 'npm run test:e2e', 40_000, 5));
    t.services.store.insertTestRun(run(id, 'lint', 'npm run lint', 20_000, 5));
    for (const stage of ['implement', 'fix', 'plan']) {
      const prompt = await promptFor(id, stage);
      expect(prompt, stage).toContain('- End-to-end tests `npm run test:e2e`: about 40 s (median of 1 recent run) — **Test stage only**\n');
      expect(prompt, stage).toContain('The checks above other than the end-to-end tests are not slow here');
      expect(prompt, stage).toContain('**End-to-end tests are left to the Test stage, however quick they are.**');
      expect(prompt, stage).not.toMatch(fine);
    }

    // A repository whose only costed check is end-to-end gets the rule and no "fine to run" line at all.
    const only = await createTask(t, await addRepo(t, await makeRepo({ scripts: { 'test:e2e': 'node -e "0"' } })), 'Fix a page', { start: false });
    const alone = await promptFor(only, 'implement');
    expect(alone).toContain('**End-to-end tests are left to the Test stage, however quick they are.**');
    expect(alone).not.toContain('in full is fine');
  });
});
