import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { api, expectNoAxeViolations, expectNoHorizontalOverflow, setTheme, trackConsoleErrors } from './helpers';

/**
 * Affected tests only (docs/plans/AFFECTED_TESTS_PLAN.md §3.5): the repository
 * switch in the Commands panel is off by default, saves, and survives a reload,
 * in both themes and at phone width.
 */

function fixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-e2e-affected-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'affected', private: true, scripts: { test: 'vitest run' } }, null, 2));
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

const repos: Record<string, string> = {};

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  // Named to sort after the demo's api-gateway: Source Control opens the first repository by name.
  for (const theme of ['dark', 'light']) repos[theme] = (await api<{ id: string }>(page, 'POST', '/api/repositories', { path: fixtureRepo(), name: `test-selection-${theme}` })).id;
  await page.close();
});

for (const theme of ['dark', 'light'] as const) {
  test.describe(`affected tests in the ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await setTheme(page, theme);
    });

    test('the switch is off by default, saves, and stays on after a reload', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`/repositories/${repos[theme]}`);
      const toggle = page.getByRole('switch', { name: 'Run only affected unit tests' });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(page.getByText(/The whole suite still runs when configuration, data, test setup, or deleted or renamed files change\./)).toBeVisible();
      await expectNoAxeViolations(page, testInfo);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await page.getByRole('button', { name: 'Save Changes' }).click();
      await expect(page.getByText('Repository settings saved')).toBeVisible();
      expect((await api<{ testSelection: string }>(page, 'GET', `/api/repositories/${repos[theme]}`)).testSelection).toBe('changed');
      await page.reload();
      await expect(page.getByRole('switch', { name: 'Run only affected unit tests' })).toHaveAttribute('aria-checked', 'true');
      expect(errors).toEqual([]);
    });

    test('the switch fits a phone', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/repositories/${repos[theme]}`);
      await expect(page.getByRole('switch', { name: 'Run only affected unit tests' })).toBeVisible();
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
