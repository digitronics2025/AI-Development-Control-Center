import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, setTheme, trackConsoleErrors } from './helpers';

/**
 * Source Control (design.md §7.9) against the real orchestrator and a real
 * repository with a local bare remote (scripts/demo.mjs → api-gateway).
 * The tests run in order and share that repository's state.
 */
const repoDir = path.join(process.env.ACC_E2E_DATA_ROOT!, 'repos', 'api-gateway');

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  await setTheme(page, 'dark');
  await page.close();
});

async function openSourceControl(page: Page, query = '') {
  await page.goto(`/source-control${query}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Source Control' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Repository' })).toHaveText(/api-gateway/);
}

const group = (page: Page, name: string) => page.getByRole('list', { name: new RegExp(`^${name}`) });

test('shows branch state, staged/unstaged groups and lazy per-file diffs', async ({ page }, testInfo) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSourceControl(page);
  const branch = page.getByRole('region', { name: 'Branch' });
  await expect(branch).toContainText('main');
  await expect(branch).toContainText('origin/main');
  await expect(branch).toContainText('Ahead 1');
  await expect(group(page, 'Staged')).toContainText('routes.ts');
  await expect(group(page, 'Changes')).toContainText('README.md');
  await expect(group(page, 'Changes')).toContainText('todo.md');
  // The staged file is selected first; its staged diff loads lazily.
  await expect(page.getByRole('table', { name: 'Diff' })).toContainText('/status');
  await group(page, 'Changes').getByRole('button', { name: /^modified README\.md/ }).click();
  await expect(page.getByRole('table', { name: 'Diff' })).toContainText('Gateway in front of the internal APIs.');
  await expectNoAxeViolations(page, testInfo);
  expect(errors).toEqual([]);
});

test('stages, unstages and commits exactly what is staged; history shows the commit', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSourceControl(page);
  await page.getByRole('button', { name: 'Stage README.md' }).click();
  await expect(group(page, 'Staged')).toContainText('README.md');
  await page.getByRole('button', { name: 'Unstage README.md' }).click();
  await expect(group(page, 'Changes')).toContainText('README.md');

  // Multi-select staging.
  await page.getByRole('checkbox', { name: 'Select README.md' }).check();
  await page.getByRole('checkbox', { name: 'Select notes/todo.md' }).check();
  await page.getByRole('button', { name: 'Stage selected (2)' }).click();
  await expect(group(page, 'Staged')).toContainText('todo.md');
  await expect(page.getByText('No unstaged changes.')).toBeVisible();

  await page.getByLabel('Commit message').fill('Expose the status route');
  await page.getByRole('button', { name: 'Commit 3 files' }).click();
  await expect(page.getByText(/Committed 3 files as [0-9a-f]{10}/)).toBeVisible();
  await expect(page.getByText('Nothing to commit')).toBeVisible();
  await expect(page.getByLabel('Commit message')).toHaveValue('');

  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page).toHaveURL(/tab=history/);
  const history = page.getByRole('list', { name: 'Commit history' });
  const first = history.getByRole('listitem').first();
  await expect(first).toContainText('Expose the status route');
  await expect(first).toContainText('Source Control');
  await expect(history).toContainText('Merge feature/rate-limit');
  await expect(history).toContainText('v1.0.0');
  await first.getByRole('button').first().click();
  const drawer = page.getByRole('dialog', { name: 'Expose the status route' });
  await expect(drawer).toContainText('README.md');
  await drawer.getByRole('button', { name: /src\/routes\.ts/ }).click();
  await expect(drawer.getByRole('table', { name: 'Diff' })).toContainText('/status');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // Operations are recorded as audit evidence.
  await page.getByRole('tab', { name: /Changes/ }).click();
  await page.getByRole('button', { name: /Recent Git operations/ }).click();
  await expect(page.getByText('Committed 3 files as', { exact: false }).last()).toBeVisible();
});

test('Sync states its plan first, then pushes the local commits', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSourceControl(page);
  await expect(page.getByRole('region', { name: 'Branch' })).toContainText('Ahead 2');
  await page.getByRole('button', { name: 'Sync…' }).click();
  const dialog = page.getByRole('dialog', { name: /Sync main with origin\/main/ });
  await expect(dialog).toContainText('Fetch origin');
  await expect(dialog).toContainText('Then push 2 local commits to origin/main');
  await dialog.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText('Pushed 2 commits to origin/main')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Branch' })).toContainText('Up to date');
});

test('a sensitive file is flagged, skipped by Stage All and blocks the commit', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const envFile = path.join(repoDir, '.env');
  writeFileSync(envFile, 'DATABASE_URL=postgres://localhost/dev\n');
  writeFileSync(path.join(repoDir, 'CHANGELOG.md'), '# Changelog\n');
  try {
    await openSourceControl(page);
    await expect(group(page, 'Changes')).toContainText('.env');
    await expect(group(page, 'Changes').getByText('Sensitive')).toBeVisible();
    await page.getByRole('button', { name: 'Stage all' }).click();
    await expect(page.getByText('1 file was left unstaged')).toBeVisible();
    await expect(group(page, 'Staged')).toContainText('CHANGELOG.md');
    await expect(group(page, 'Changes')).toContainText('.env');

    await page.getByRole('button', { name: 'Stage .env' }).click();
    await expect(group(page, 'Staged')).toContainText('.env');
    await page.getByLabel('Commit message').fill('Should not happen');
    await page.getByRole('button', { name: 'Commit 2 files' }).click();
    const banner = page.getByRole('alert').filter({ hasText: 'The commit did not happen' });
    await expect(banner).toContainText('.env');
    await expect(banner).toContainText('environment file');
    await page.getByRole('button', { name: 'Unstage all' }).click();
    await expect(page.getByText('Nothing staged yet.')).toBeVisible();
  } finally {
    rmSync(envFile, { force: true });
    if (existsSync(path.join(repoDir, 'CHANGELOG.md'))) rmSync(path.join(repoDir, 'CHANGELOG.md'), { force: true });
  }
  await expect(page.getByText('Nothing to commit')).toBeVisible({ timeout: 15_000 });
});

test('works at phone width without page-level horizontal scroll', async ({ page }) => {
  writeFileSync(path.join(repoDir, 'mobile-note.md'), 'narrow\n');
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSourceControl(page);
    await expect(group(page, 'Changes')).toContainText('mobile-note.md');
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    await expect(page.getByRole('table', { name: 'Diff' })).toContainText('narrow');
  } finally {
    rmSync(path.join(repoDir, 'mobile-note.md'), { force: true });
  }
});
