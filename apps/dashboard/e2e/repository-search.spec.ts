import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { api, expectNoAxeViolations, setTheme, trackConsoleErrors } from './helpers';

/**
 * Repositories are found by name, in any word order and with a small typo,
 * from the Repositories page search box and from the Ctrl+K palette.
 */

const NAME = 'Pocket-calculator';
const root = path.join(process.env.ACC_E2E_DATA_ROOT!, 'repository-search');
let repoId = '';

test.beforeAll(async ({ browser }) => {
  rmSync(root, { recursive: true, force: true });
  const dir = path.join(root, 'pocket-calculator');
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pocket-calculator', private: true }, null, 2));
  git('add', '-A');
  git('commit', '-qm', 'init');
  const page = await browser.newPage();
  await page.goto('/');
  repoId = (await api<{ id: string }>(page, 'POST', '/api/repositories', { path: dir, name: NAME })).id;
  await page.close();
});

for (const theme of ['light', 'dark'] as const) {
  test(`the Repositories search narrows the list and forgives a typo (${theme})`, async ({ page }, testInfo) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/repositories');
    await setTheme(page, theme);
    const search = page.getByRole('searchbox', { name: 'Search repositories' });
    const table = page.getByRole('table', { name: 'Repositories' });

    await search.fill('calcualtor pokcet');
    await expect(table.getByRole('link', { name: NAME })).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(2); // header + the one match
    await expect(page).toHaveURL(/[?&]q=calcualtor/);

    await search.fill('zzzz-nothing');
    await expect(page.getByText('No repository matches “zzzz-nothing”')).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(search).toHaveValue('');
    await expect(table.getByRole('link', { name: NAME })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('the Ctrl+K palette opens a repository found with a typo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  // Repositories are not listed before anything is typed.
  await expect(palette.getByRole('option', { name: NAME })).toHaveCount(0);
  await page.keyboard.type('pokcet');
  await expect(palette.getByRole('option').first()).toHaveText(NAME);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/repositories/${repoId}$`));
});
