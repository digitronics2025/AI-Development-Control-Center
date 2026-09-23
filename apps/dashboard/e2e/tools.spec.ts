import { expect, test } from '@playwright/test';
import { api, setTheme, trackConsoleErrors } from './helpers';

/**
 * Tools section and task Execution tab (design.md §7.10, §7.3) against the
 * real orchestrator: tool health, the credential broker's write-only form,
 * the execution policy, and a real interactive terminal typed into from the
 * browser.
 */
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  await setTheme(page, 'dark');
  await page.close();
});

test('Tools lists the machine’s tools and opens one with its capabilities', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/tools');
  await expect(page.getByRole('link', { name: 'Tools' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Git' });
  await expect(drawer).toContainText('git.status');
  await drawer.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(drawer.getByText('Ready')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  expect(errors).toEqual([]);
});

test('a stored credential never comes back to the page', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/tools/credentials');
  const value = ['e2e', 'credential', 'value', String(Date.now())].join('-');
  await page.getByRole('button', { name: 'Add credential' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a credential' });
  await dialog.getByLabel('Name').fill('e2e-api');
  await dialog.getByLabel('Value').fill(value);
  await expect(dialog.getByLabel('Value')).toHaveAttribute('type', 'password');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'e2e-api' }).or(page.getByText('e2e-api')).first()).toBeVisible();
  expect(await page.content()).not.toContain(value);
  const listed = await api<Array<{ name: string }>>(page, 'GET', '/api/credentials');
  expect(JSON.stringify(listed)).not.toContain(value);
  expect(errors).toEqual([]);
});

test('the execution policy is one segmented choice and persists', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/tools/policy');
  await page.getByRole('radio', { name: 'Safe' }).click();
  await expect(page.getByText('anything above Level 2 asks first')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Safe' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: /Autopilot \(recommended\)/ }).click();
  await expect(page.getByRole('radio', { name: /Autopilot \(recommended\)/ })).toHaveAttribute('aria-checked', 'true');
});

test('a terminal opened from the dashboard runs real commands', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/tools/terminals');
  await page.getByRole('combobox', { name: 'Repository' }).click();
  await page.getByRole('option', { name: 'docs-site' }).click();
  await page.getByRole('button', { name: 'New terminal' }).click();
  const drawer = page.getByRole('dialog', { name: /Terminal · docs-site/ });
  await expect(drawer).toContainText('Commands typed here run as you');
  const terminal = drawer.getByRole('region', { name: /Terminal/ });
  await expect(terminal.locator('.xterm-screen')).toBeVisible();
  await terminal.click();
  const command = process.platform === 'win32' ? 'Write-Output ("from-browser-" + (40 + 2))' : 'echo from-browser-$((40 + 2))';
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await expect(terminal.locator('.xterm-rows')).toContainText('from-browser-42', { timeout: 20_000 });
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect.poll(async () => (await api<Array<{ status: string }>>(page, 'GET', '/api/terminals')).every((t) => t.status === 'exited'), { timeout: 15_000 }).toBe(true);
  expect(errors).toEqual([]);
});

test('the Execution tab shows what ran for a task', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/tasks/TASK-0001?tab=execution');
  await expect(page.getByRole('heading', { name: 'Tool calls' })).toBeVisible();
  await expect(page.getByText(/Policy: /)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Checkpoints' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Background processes' })).toBeVisible();
  expect(errors).toEqual([]);
});
