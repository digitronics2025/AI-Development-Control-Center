import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { api, expectNoAxeViolations, expectNoHorizontalOverflow, setTheme, trackConsoleErrors } from './helpers';

/**
 * Full Autopilot brings in the design specialist only for user-interface work
 * (docs/plans/DESIGNER_ROUTING_PLAN.md): a backend task shows its Visual critique
 * as skipped — no agent, the reason — and a UI task shows it run; the workflow
 * editor says when the critique runs. Both themes, desktop and phone.
 */

function fixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-e2e-design-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'design-routing', private: true, scripts: { test: 'node -e "0"' } }, null, 2));
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

async function waitForTask(page: Page, id: string): Promise<{ status: string }> {
  for (let i = 0; i < 400; i++) {
    const task = await api<{ status: string }>(page, 'GET', `/api/tasks/${id}`);
    if (['COMPLETED', 'FAILED', 'WAITING_FOR_USER'].includes(task.status)) return task;
    await page.waitForTimeout(250);
  }
  throw new Error(`${id} never finished`);
}

let backendTask = '';
let uiTask = '';

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  const repo = await api<{ id: string }>(page, 'POST', '/api/repositories', { path: fixtureRepo(), name: 'design-routing' });
  backendTask = (await api<{ id: string }>(page, 'POST', '/api/tasks', { repositoryId: repo.id, workflowId: 'full-autopilot', mode: 'autopilot', description: 'Tidy the API handler.' })).id;
  expect((await waitForTask(page, backendTask)).status).toBe('COMPLETED');
  uiTask = (await api<{ id: string }>(page, 'POST', '/api/tasks', { repositoryId: repo.id, workflowId: 'full-autopilot', mode: 'autopilot', description: 'Restyle the card. [sim:ui]' })).id;
  expect((await waitForTask(page, uiTask)).status).toBe('COMPLETED');
  await page.close();
});

for (const theme of ['dark', 'light'] as const) {
  test.describe(`design routing in the ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await setTheme(page, theme);
    });

    test('a backend task shows the critique skipped, with no agent; a UI task shows it run', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/tasks/${backendTask}`);
      const stages = page.getByRole('list', { name: 'Workflow stages' });
      const critique = stages.getByRole('listitem').filter({ hasText: 'Visual critique' });
      await expect(critique).toContainText('Skipped');
      await expect(critique.getByTitle('Skipped: No user-interface files changed in this task')).toBeVisible();
      await expect(critique).not.toContainText('Claude Code');
      await expect(stages.getByRole('listitem').filter({ hasText: 'Design fix' })).toHaveCount(0);
      await expectNoAxeViolations(page, testInfo);

      await page.goto(`/tasks/${uiTask}`);
      const ran = page.getByRole('list', { name: 'Workflow stages' }).getByRole('listitem').filter({ hasText: 'Visual critique' });
      await expect(ran).not.toContainText('Skipped');
      await expect(ran).toContainText(/Codex|Claude Code/);
      await expectNoAxeViolations(page, testInfo);
      expect(errors).toEqual([]);
    });

    test('the workflow editor says when the critique runs', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto('/workflows/full-autopilot');
      await page.getByRole('button', { name: /Visual critique/ }).first().click();
      await expect(page.getByText('Runs only when user-interface files change')).toBeVisible();
      await expectNoAxeViolations(page, testInfo);
      expect(errors).toEqual([]);
    });

    test('the skipped stage fits a phone', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/tasks/${backendTask}`);
      await expect(page.getByRole('list', { name: 'Workflow stages' }).getByRole('listitem').filter({ hasText: 'Visual critique' })).toContainText('Skipped');
      await expectNoHorizontalOverflow(page);
    });
  });
}
