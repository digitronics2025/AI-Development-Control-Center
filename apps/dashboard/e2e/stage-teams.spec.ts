import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { api, expectNoAxeViolations, expectNoHorizontalOverflow, setTheme, trackConsoleErrors } from './helpers';

/**
 * Stage Teams in the dashboard (docs/plans/STAGE_TEAMS_PLAN.md §3.14): the
 * workflow editor's Execution control (read-only on a built-in team workflow,
 * editable on a copy), the task page's team line and Stage Team panel, and the
 * cost ledger's per-unit rows — at desktop and phone width, in both themes.
 * The demo's simulated tasks never ran as a team, so the task and ledger
 * responses get work units added on the way to the page.
 */

const WIDTHS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

async function check(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await expectNoHorizontalOverflow(page);
  await testInfo.attach(`${name}.png`, { body: await page.screenshot({ fullPage: false }), contentType: 'image/png' });
  await expectNoAxeViolations(page, testInfo);
}

interface StageLite {
  id: string;
  stageKey: string;
  taskId: string;
}

function unit(stage: StageLite, n: number, patch: Record<string, unknown>) {
  const at = new Date(Date.now() - 180_000).toISOString();
  return {
    id: `wu-e2e-${n}`,
    taskId: stage.taskId,
    stageId: stage.id,
    stageKey: stage.stageKey,
    unitKey: `unit-${n}`,
    kind: 'worker',
    title: `Unit ${n}`,
    focus: '',
    status: 'SUCCESS',
    ordinal: n,
    dependencies: [],
    pathScope: [],
    primary: false,
    manifestHash: null,
    baseCommit: null,
    resultCommit: null,
    agentId: 'claude',
    model: null,
    effort: null,
    attempt: 1,
    reusedFrom: null,
    summary: null,
    errorClass: null,
    errorMessage: null,
    startedAt: at,
    finishedAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: at,
    ...patch,
  };
}

/** Adds a team to TASK-0001's last agent stage: one done, one failed, one reused, and the integration pass. */
async function withTeam(page: Page): Promise<void> {
  await page.route(/\/api\/tasks\/TASK-0001$/, async (route) => {
    const response = await route.fetch();
    const task = (await response.json()) as { stages: StageLite[]; workflow: { stages: Array<{ key: string; kind: string }> } };
    const agentKeys = new Set(task.workflow.stages.filter((s) => s.kind === 'agent').map((s) => s.key));
    const stage = [...task.stages].reverse().find((s) => agentKeys.has(s.stageKey))!;
    const workUnits = [
      unit(stage, 1, { title: 'Backend changes' }),
      unit(stage, 2, { title: 'Dashboard changes', status: 'FAILED', agentId: 'codex', errorMessage: 'The unit changed a file outside its paths: packages/shared/src/index.ts' }),
      unit(stage, 3, { title: 'Shared types', status: 'REUSED' }),
      unit(stage, 4, { kind: 'integration', title: 'Integration', status: 'QUEUED', startedAt: null, finishedAt: null }),
    ];
    await route.fulfill({ response, json: { ...task, workUnits } });
  });
  await page.route(/\/api\/usage\/tasks\/TASK-0001$/, async (route) => {
    const response = await route.fetch();
    const ledger = (await response.json()) as { flow: Array<{ totals: Record<string, number>; workUnits?: unknown[] }> };
    const first = ledger.flow[0];
    if (first) first.workUnits = [
      { unitKey: 'backend', agentId: 'claude', models: ['default'], attempts: 1, totals: first.totals },
      { unitKey: 'dashboard', agentId: 'codex', models: ['default'], attempts: 2, totals: first.totals },
    ];
    await route.fulfill({ response, json: ledger });
  });
}

let copyId = '';

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  copyId = (await api<{ id: string }>(page, 'POST', '/api/workflows/normal-development/duplicate')).id;
  await page.close();
});

for (const theme of ['dark', 'light'] as const) {
  test.describe(`stage teams in the ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await setTheme(page, theme);
    });

    test('a built-in team workflow shows its team read-only', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      for (const size of WIDTHS) {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto('/workflows/architecture');
        await expect(page.getByText('Fixed team of 2').first()).toBeVisible();
        await page.getByRole('button', { name: /^\d+\.\s*Review/ }).click();
        const inspector = size.name === 'desktop' ? page.locator('aside').filter({ has: page.getByRole('heading', { name: 'Stage: Review' }) }) : page.getByRole('dialog');
        await expect(inspector.getByRole('combobox', { name: 'Execution' })).toHaveText(/Fixed team/);
        await expect(inspector.getByRole('switch', { name: 'Architecture, security and data risks: primary reviewer' })).toBeDisabled();
        await expect(inspector.getByRole('switch', { name: 'Correctness of the whole diff: primary reviewer' })).toHaveAttribute('aria-checked', 'true');
        await check(page, testInfo, `workflow-builtin-${size.name}-${theme}`);
      }
      expect(errors).toEqual([]);
    });

    test('a custom workflow stage becomes a fixed review team', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      for (const size of WIDTHS) {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto(`/workflows/${copyId}`);
        await page.getByRole('button', { name: /^\d+\.\s*Review/ }).click();
        const inspector = size.name === 'desktop' ? page.locator('aside').filter({ has: page.getByRole('heading', { name: 'Stage: Review' }) }) : page.getByRole('dialog');
        await inspector.getByRole('combobox', { name: 'Execution' }).click();
        await page.getByRole('option', { name: /Fixed team/ }).click();
        await expect(inspector.getByRole('button', { name: 'Add worker' })).toBeVisible();
        // Saving is blocked until every worker has a focus.
        await expect(page.getByText(/saving is blocked/)).toBeVisible();
        const focus = inspector.getByRole('textbox', { name: 'Focus' });
        await focus.nth(0).fill('Correctness');
        await focus.nth(1).fill('Security');
        // The first worker starts as the primary reviewer; there is only ever one.
        await expect(inspector.getByRole('switch', { name: 'Correctness: primary reviewer' })).toHaveAttribute('aria-checked', 'true');
        await inspector.getByRole('switch', { name: 'Security: primary reviewer' }).click();
        await expect(inspector.getByRole('switch', { name: 'Correctness: primary reviewer' })).toHaveAttribute('aria-checked', 'false');
        await expect(page.getByText(/saving is blocked/)).toHaveCount(0);
        await check(page, testInfo, `workflow-custom-${size.name}-${theme}`);
      }
      expect(errors).toEqual([]);
    });

    test('the task page shows the team on the timeline and in Execution', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      await withTeam(page);
      for (const size of WIDTHS) {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto('/tasks/TASK-0001?tab=execution');
        await expect(page.getByText('Team of 3 · 1 failed')).toBeVisible();
        const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Stage Team' }) });
        await expect(panel.getByText('Backend changes')).toBeVisible();
        await expect(panel.getByText('The unit changed a file outside its paths')).toBeVisible();
        await expect(panel.getByText(/^reused an earlier result/)).toBeVisible();
        await expect(panel.getByText('Integration', { exact: true })).toBeVisible();
        await check(page, testInfo, `task-team-${size.name}-${theme}`);
      }
      await page.goto('/usage/tasks/TASK-0001');
      const members = page.getByRole('list', { name: /team members/ });
      await expect(members.getByText('dashboard')).toBeVisible();
      await expect(members.getByText(/2 attempts/)).toBeVisible();
      await check(page, testInfo, `usage-team-mobile-${theme}`);
      expect(errors).toEqual([]);
    });
  });
}
