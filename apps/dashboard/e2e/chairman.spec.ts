import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { api, expectNoAxeViolations, expectNoHorizontalOverflow, setTheme, trackConsoleErrors } from './helpers';

/**
 * Chairman supervisor and chat against the real orchestrator (plan §7.7,
 * design.md §7.3.1). Each task gets its own throwaway repository so the
 * seeded demo tasks are not disturbed.
 */

/** Inside the run's data root (reused per port), so repositories never pile up in the temp folder. */
const reposRoot = path.join(process.env.ACC_E2E_DATA_ROOT!, 'chairman');

function repoWithCheck(check: string): string {
  mkdirSync(reposRoot, { recursive: true });
  const dir = mkdtempSync(path.join(reposRoot, 'repo-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'chairman-e2e', private: true, scripts: { test: 'node check.js' } }, null, 2));
  writeFileSync(
    path.join(dir, 'check.js'),
    ["const fs = require('fs');", "const n = fs.existsSync('sim-output.md') ? fs.readFileSync('sim-output.md', 'utf8').split('\\n').filter(Boolean).length : 0;", check].join('\n'),
  );
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

async function newTask(page: Page, check: string, description: string): Promise<string> {
  // Named to sort after the seeded repositories: other specs select the first one.
  const repo = await api<{ id: string }>(page, 'POST', '/api/repositories', { path: repoWithCheck(check), name: `zz-chairman-${Date.now()}` });
  // Its checks fail before any change too; strict mode keeps them failures the task must fix.
  await api(page, 'PATCH', `/api/repositories/${repo.id}`, { preexistingFailures: 'block' });
  const task = await api<{ id: string }>(page, 'POST', '/api/tasks', { repositoryId: repo.id, workflowId: 'normal-development', mode: 'autopilot', description });
  return task.id;
}

async function openChairman(page: Page) {
  await page.getByRole('button', { name: /^Chairman — / }).click();
  const drawer = page.getByRole('dialog', { name: 'Chairman' });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function say(page: Page, text: string) {
  const drawer = page.getByRole('dialog', { name: 'Chairman' });
  await drawer.getByLabel('Message the Chairman').fill(text);
  await drawer.getByLabel('Message the Chairman').press('Enter');
  await expect(drawer.getByLabel('Message the Chairman')).toHaveValue('');
}

test.beforeAll(async ({ browser }) => {
  // The demo server starts with a fresh database, so the previous run's repositories are unused.
  rmSync(reposRoot, { recursive: true, force: true });
  const page = await browser.newPage();
  await page.goto('/');
  await setTheme(page, 'dark');
  await page.close();
});

test.describe('Decisions only the operator can make', () => {
  test('a stage that needs your decision stops with the question; Answer continues the task', async ({ page }, testInfo) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const id = await newTask(page, "console.log('9 passed');", 'Round prices [sim:needs-decision]');
    await page.goto(`/tasks/${id}`);
    const banner = page.getByRole('alert').filter({ hasText: 'Implement needs your decision' });
    await expect(banner).toBeVisible({ timeout: 60_000 });
    await expect(banner).toContainText('Which rounding rule is right');
    await page.getByRole('button', { name: 'Answer', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Answer the question' });
    await expect(dialog).toContainText('Which rounding rule is right');
    await expectNoAxeViolations(page, testInfo);
    await dialog.getByLabel('Your answer').fill('ANSWER: round halves up everywhere.');
    await dialog.getByRole('button', { name: 'Answer and continue' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Answer recorded; the task continues' })).toBeVisible();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    expect(errors).toEqual([]);
  });
});

test.describe('Chairman (plan §7.7)', () => {
  test('recovers automatically: exhausted fixes start a recovery cycle and the task still completes', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const id = await newTask(page, "const f = 6 - n; if (f > 0) { console.log('FAIL test/a.test.js > adds'); console.log(f + ' failed, 3 passed'); process.exit(1); } console.log('9 passed');", 'Fix the adder until the suite passes.');
    await page.goto(`/tasks/${id}`);
    // Keyboard: the header button opens the drawer.
    await page.getByRole('button', { name: /^Chairman — / }).focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: 'Chairman' });
    await expect(drawer).toBeVisible();
    const log = drawer.getByRole('log', { name: 'Chairman conversation' });
    // The decision appears in the chat by itself, with its trigger and who chose it.
    await expect(log.getByText('Fix attempts exhausted').first()).toBeVisible({ timeout: 60_000 });
    await expect(log.getByText(/Root-cause analysis|Simulated Chairman chose rca/).first()).toBeVisible();
    // The same card shows the diagnosis and prediction, then what actually happened once the next tests ran.
    const card = log.locator('[data-decision-id]').filter({ hasText: 'Fix attempts exhausted' });
    await expect(card).toHaveCount(1);
    await expect(card.getByText('Model', { exact: true })).toBeVisible();
    await expect(card.getByText(/^Diagnosis: Code or test · medium confidence — Simulated diagnosis/)).toBeVisible();
    await expect(card.getByText('Expected: The failure no longer occurs.')).toBeVisible();
    await expect(card.getByText('Improved', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(card.getByText('Result: Failing tests went from 2 to 1.')).toBeVisible();
    // Republishing the decision with its outcome updated the card; it did not add a second one.
    const cardIds = await log.locator('[data-decision-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-decision-id')));
    expect(new Set(cardIds).size).toBe(cardIds.length);
    await page.keyboard.press('Escape');
    await expect(page.getByText('Recovery cycle 1').first()).toBeVisible();
    await expect(page.getByText('Completed', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('Ready', { exact: true }).first()).toBeVisible();
    await page.getByRole('tab', { name: 'Activity' }).click();
    await expect(page.getByText(/Recovery cycle 1: Root-cause analysis in Investigate/)).toBeVisible();
    await expect(page.getByText('Chairman: Root-cause analysis in Investigate — Improved. Failing tests went from 2 to 1.')).toBeVisible();

    // A reload rebuilds the card from the orchestrator alone; at phone width, in both themes, it stays readable.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    const phone = await openChairman(page);
    const phoneCard = phone.getByRole('log', { name: 'Chairman conversation' }).locator('[data-decision-id]').filter({ hasText: 'Fix attempts exhausted' });
    await expect(phoneCard.getByText('Improved', { exact: true })).toBeVisible();
    await phoneCard.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page);
    await expectNoAxeViolations(page, test.info());
    await setTheme(page, 'light');
    try {
      await expect(phoneCard.getByText(/^Diagnosis: /)).toBeVisible();
      await expectNoAxeViolations(page, test.info());
    } finally {
      await setTheme(page, 'dark');
    }
    expect(errors).toEqual([]);
  });

  test('chat reads real state, answers questions without acting, and applies directives and commands safely', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const id = await newTask(page, "console.log('4 passed');", 'Long job for the Chairman chat [sim:slow]');
    await page.goto(`/tasks/${id}`);
    const drawer = await openChairman(page);
    const log = drawer.getByRole('log', { name: 'Chairman conversation' });
    await expectNoAxeViolations(page, test.info());

    await say(page, '/status');
    await expect(log.getByText(new RegExp(`${id} is (running|queued)`)).first()).toBeVisible();

    await say(page, 'Would rollback help?');
    await expect(log.getByText(/Simulated Chairman: the task is/).first()).toBeVisible({ timeout: 20_000 });
    await expect(log.getByText('Roll back to checkpoint')).toHaveCount(0);

    await say(page, 'Do not modify the database schema.');
    const directives = drawer.getByRole('region', { name: /Active directives/ });
    await expect(directives).toContainText('Do not modify the database schema.');
    await expect(directives).toContainText('Constraint');
    await expect(log.getByText('Add directive').first()).toBeVisible();

    await say(page, 'Pause after the current stage.');
    await expect(log.getByText('Pause task').first()).toBeVisible();
    await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible({ timeout: 30_000 });

    await say(page, 'Continue and decide the rest yourself.');
    await expect(log.getByText(/Continue/).first()).toBeVisible();
    await expect(page.getByText('Running', { exact: true }).first()).toBeVisible({ timeout: 20_000 });

    // Immediate redirect while an agent is working.
    await expect.poll(async () => (await api<{ currentStageKey: string; status: string }>(page, 'GET', `/api/tasks/${id}`)).currentStageKey, { timeout: 60_000 }).toBe('implement');
    await say(page, 'Stop this fix and go back to Investigate.');
    await expect(log.getByText(/Returning to Investigate|Set to Investigate/).first()).toBeVisible({ timeout: 20_000 });

    await directives.getByRole('button', { name: /^Remove directive: Do not modify the database schema/ }).click();
    await expect(drawer.getByRole('region', { name: /Active directives/ })).toHaveCount(0);
    expect(errors).toEqual([]);
    await api(page, 'POST', `/api/tasks/${id}/cancel`);
  });

  test('the drawer works at phone width and in the light theme', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await setTheme(page, 'light');
    try {
      const id = await newTask(page, "console.log('4 passed');", 'Phone-width check');
      await page.goto(`/tasks/${id}`);
      const drawer = await openChairman(page);
      await expect(drawer.getByLabel('Message the Chairman')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(page, test.info());
      const box = await drawer.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(389);
    } finally {
      await setTheme(page, 'dark');
    }
  });
});
