import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { api, expectNoAxeViolations, expectNoHorizontalOverflow, setTheme, trackConsoleErrors } from './helpers';

/**
 * Gates that tell the truth (docs/plans/AUTOPILOT_GATES_PLAN.md): the Tests
 * tab's pre-existing, reused and waived states, the "Don't gate this task on"
 * row, the repository callout and the task header's working folder, in both
 * themes and at phone width.
 */

/** A repository whose checks print failing tests the way Vitest does. */
function fixtureRepo(scripts: Record<string, string>, files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-e2e-gates-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'gates', private: true, scripts }, null, 2));
  for (const [file, content] of Object.entries(files)) writeFileSync(path.join(dir, file), content);
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

const failing = (ids: string[], onlyAfterChange = false) =>
  [
    "const fs = require('fs');",
    `const failed = ${onlyAfterChange ? "fs.existsSync('sim-output.md') ? " : ''}${JSON.stringify(ids)}${onlyAfterChange ? ' : []' : ''};`,
    "for (const f of failed) console.log(' FAIL  ' + f);",
    "console.log(failed.length ? ' Tests  ' + failed.length + ' failed | 3 passed' : ' Tests  3 passed');",
    'process.exit(failed.length ? 1 : 0);',
  ].join('\n');

async function waitForTask(page: Page, id: string, statuses: string[]): Promise<{ status: string }> {
  for (let i = 0; i < 300; i++) {
    const task = await api<{ status: string }>(page, 'GET', `/api/tasks/${id}`);
    if (statuses.includes(task.status)) return task;
    await page.waitForTimeout(250);
  }
  throw new Error(`${id} never reached ${statuses.join('/')}`);
}

let preexistingTask = '';
let waitingTask = '';
let legacyRepo = '';

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  // A task whose unit tests already fail on its baseline, tested twice on the same files.
  const oldRepo = await api<{ id: string }>(page, 'POST', '/api/repositories', { path: fixtureRepo({ lint: 'node -e "0"', test: 'node check.js' }, { 'check.js': failing(['src/partners.test.ts > Partners > rounds halves']) }), name: 'gates-baseline' });
  await api(page, 'PUT', '/api/workflows/gates-twice', {
    id: 'gates-twice',
    name: 'Gates twice',
    maxFixCycles: 1,
    stages: [
      { key: 'implement', name: 'Implement', role: 'implementer', permissionLevel: 2, next: 'test' },
      { key: 'test', name: 'Test', role: 'tester', kind: 'tests', permissionLevel: 2, next: 'again' },
      { key: 'again', name: 'Test again', role: 'tester', kind: 'tests', permissionLevel: 2, next: 'complete' },
    ],
  });
  preexistingTask = (await api<{ id: string }>(page, 'POST', '/api/tasks', { repositoryId: oldRepo.id, workflowId: 'gates-twice', mode: 'autopilot', supervised: false, description: 'Tidy the partners list.' })).id;
  // A task whose end-to-end suite fails only after its change: it stops at the fix limit, in its worktree.
  const newRepo = await api<{ id: string }>(page, 'POST', '/api/repositories', {
    path: fixtureRepo({ test: 'node -e "0"', 'test:e2e': 'node e2e.js' }, { 'e2e.js': failing(['e2e/banks.spec.ts > Banks > creates an account'], true) }),
    name: 'gates-new-failure',
  });
  waitingTask = (await api<{ id: string }>(page, 'POST', '/api/tasks', { repositoryId: newRepo.id, workflowId: 'full-autopilot', mode: 'autopilot', supervised: false, maxFixCycles: 0, description: 'Rework the bank form.' })).id;
  // A repository added before worktrees were the default.
  legacyRepo = (await api<{ id: string }>(page, 'POST', '/api/repositories', { path: fixtureRepo({ test: 'node -e "0"' }, {}), name: 'gates-legacy' })).id;
  await api(page, 'PATCH', `/api/repositories/${legacyRepo}`, { gitMode: 'task-branch' });
  await waitForTask(page, preexistingTask, ['COMPLETED', 'FAILED', 'WAITING_FOR_USER']);
  await waitForTask(page, waitingTask, ['WAITING_FOR_USER', 'FAILED', 'COMPLETED']);
  await page.close();
});

for (const theme of ['dark', 'light'] as const) {
  test.describe(`gates in the ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await setTheme(page, theme);
    });

    test('the Tests tab separates pre-existing failures and reused passes', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/tasks/${preexistingTask}?tab=tests`);
      const first = page.getByRole('region', { name: 'Test run 1' });
      await expect(first.getByRole('heading')).toContainText('1 passed · 0 failed · 1 already failing before this task');
      await expect(first.getByText('pre-existing', { exact: true })).toBeVisible();
      await expect(first.getByText('failed · already failing before this task')).toBeVisible();
      await expect(first.getByText(/1 failing test: src\/partners\.test\.ts > Partners > rounds halves/)).toBeVisible();
      // Lint passed on these exact files in Test, so Test again took that result instead of running it.
      await expect(page.getByRole('region', { name: 'Test again run 2' }).getByText('reused', { exact: true })).toBeVisible();
      await expectNoAxeViolations(page, testInfo);
      expect(errors).toEqual([]);
    });

    test('a failing check can be waived for this task only, from the directive form', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/tasks/${waitingTask}`);
      await expect(page.getByTestId('task-working-folder')).toContainText('worktrees');
      await expect(page.getByText('Works in an isolated worktree:')).toBeVisible();
      const row = page.getByRole('group', { name: "Don't gate this task on" });
      await expect(row).toBeVisible();
      await expectNoAxeViolations(page, testInfo);
      if (theme === 'light') {
        // Submitted once, in the second pass: the row then disappears because nothing is left to waive.
        await row.getByRole('checkbox', { name: 'End-to-end tests' }).click();
        await row.locator('xpath=ancestor::form').getByRole('button', { name: 'Add directive' }).click();
        await expect(page.getByText('No longer gating this task on end-to-end tests')).toBeVisible();
        await page.goto(`/tasks/${waitingTask}?tab=tests`);
        await expect(page.getByText('Not gating this task on some checks')).toBeVisible();
        await expect(page.getByText(/End-to-end tests — waived by your directive: “Don't gate this task on end-to-end tests\.”/)).toBeVisible();
      }
      expect(errors).toEqual([]);
    });

    test('a repository that runs tasks in your folder offers isolated worktrees', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/repositories/${legacyRepo}`);
      await expect(page.getByText('Tasks run in your working folder')).toBeVisible();
      await expectNoAxeViolations(page, testInfo);
      if (theme === 'light') {
        await page.getByRole('button', { name: 'Use isolated worktrees' }).click();
        await expect(page.getByText('Tasks in this repository now run in isolated worktrees')).toBeVisible();
        await expect(page.getByText('Tasks run in your working folder')).toBeHidden();
      }
      expect(errors).toEqual([]);
    });

    test('the new parts fit a phone', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/tasks/${preexistingTask}?tab=tests`);
      await expect(page.getByRole('region', { name: 'Test run 1' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.goto(`/tasks/${waitingTask}`);
      await expect(page.getByTestId('task-working-folder')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  });
}

test.afterAll(async ({ browser }) => {
  // The theme is a server setting: put back the dark theme the other files expect.
  const page = await browser.newPage();
  await page.goto('/');
  await setTheme(page, 'dark');
  await page.close();
});
