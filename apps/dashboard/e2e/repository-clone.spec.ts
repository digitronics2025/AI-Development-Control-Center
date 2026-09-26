import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations, setTheme, trackConsoleErrors } from './helpers';

/**
 * A repository that exists only "online" — a bare repository standing in for
 * GitHub — is downloaded and registered from the Add repository dialog.
 */

const root = path.join(process.env.ACC_E2E_DATA_ROOT!, 'clone');
const remote = path.join(root, 'online', 'calc-online.git');
const parent = path.join(root, 'downloads');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test.beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  const seed = path.join(root, 'seed');
  mkdirSync(seed, { recursive: true });
  mkdirSync(parent, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 'e2e@example.com');
  git(seed, 'config', 'user.name', 'E2E');
  git(seed, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(seed, 'package.json'), JSON.stringify({ name: 'calc-online', private: true, scripts: { test: 'node --test' } }, null, 2));
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'Initial calculator');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'push', '-q', remote, 'main');
});

for (const theme of ['light', 'dark'] as const) {
  test(`the Download from GitHub form is accessible (${theme})`, async ({ page }, testInfo) => {
    await page.goto('/repositories');
    await setTheme(page, theme);
    await page.getByRole('button', { name: 'Add repository' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add repository' });
    await dialog.getByRole('radio', { name: 'Download from GitHub' }).click();
    await dialog.getByLabel('Repository address').fill('owner/my-app');
    await expect(dialog.getByText(/Will be saved in .*my-app/)).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  });
}

test('downloads an online-only repository and adds it', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.goto('/repositories');
  await page.getByRole('button', { name: 'Add repository' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add repository' });
  await dialog.getByRole('radio', { name: 'Download from GitHub' }).click();
  await dialog.getByLabel('Repository address').fill('ext::sh -c id');
  await dialog.getByRole('button', { name: 'Download and add' }).click();
  await expect(dialog.getByText(/Enter a GitHub "owner\/name"/)).toBeVisible();

  await dialog.getByLabel('Repository address').fill(pathToFileURL(remote).href);
  await dialog.getByLabel('Save in folder').fill(parent);
  await dialog.getByRole('button', { name: 'Download and add' }).click();

  await expect(page).toHaveURL(/\/repositories\/[^/]+$/);
  await expect(page.getByRole('heading', { level: 1, name: 'calc-online' })).toBeVisible();
  expect(existsSync(path.join(parent, 'calc-online', 'package.json'))).toBe(true);
  expect(errors).toEqual([]);
});
