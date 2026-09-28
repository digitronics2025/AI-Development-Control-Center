import { expect, test } from '@playwright/test';
import { api, expectNoAxeViolations, expectNoHorizontalOverflow, setTheme, trackConsoleErrors } from './helpers';

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
  // Left empty, the hosts are the kind's own (SEC-4): Cloudflare's API.
  await expect(dialog.getByText('Default: api.cloudflare.com')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'e2e-api' }).or(page.getByText('e2e-api')).first()).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'e2e-api' })).toContainText('api.cloudflare.com');
  expect(await page.content()).not.toContain(value);
  const listed = await api<Array<{ name: string }>>(page, 'GET', '/api/credentials');
  expect(JSON.stringify(listed)).not.toContain(value);
  // Chosen as Ask's Cloudflare key, it is labelled Ask only (task tools never receive it).
  const row = page.getByRole('row').filter({ hasText: 'e2e-api' });
  await expect(row.getByText('Ask only')).toHaveCount(0);
  const settings = await api<{ ask: { sources: Record<string, Record<string, unknown>> } }>(page, 'GET', '/api/settings');
  const withKey = (credential: string | null) => ({ ask: { ...settings.ask, sources: { ...settings.ask.sources, cloudflare: { ...settings.ask.sources.cloudflare, credential } } } });
  await api(page, 'PATCH', '/api/settings', withKey('e2e-api'));
  await expect(row.getByText('Ask only')).toBeVisible();
  await api(page, 'PATCH', '/api/settings', withKey((settings.ask.sources.cloudflare!.credential as string | null) ?? null));
  await expect(row.getByText('Ask only')).toHaveCount(0);
  expect(errors).toEqual([]);
});

for (const theme of ['dark', 'light'] as const) {
  test(`a credential still sent to any host is marked for review until its hosts are named (${theme})`, async ({ page }, testInfo) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await setTheme(page, theme);
    try {
      const name = `e2e-legacy-${theme}`;
      const value = ['e2e', 'legacy', theme, String(Date.now())].join('-');
      await api(page, 'POST', '/api/credentials', { name, kind: 'http', value });
      // It stands in for a credential saved before hosts existed, which migration 24 marks "any host" (the migration
      // itself is covered by apps/orchestrator/test/outbound-secrets.test.ts): the list says so until hosts are named.
      await page.route(/\/api\/credentials$/, async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        const list = (await response.json()) as Array<{ name: string; audience: { hosts: string[]; anyHost: boolean; fromKind: boolean } }>;
        await route.fulfill({ response, json: list.map((c) => (c.name === name && c.audience.fromKind ? { ...c, audience: { hosts: [], anyHost: true, fromKind: false } } : c)) });
      });
      await page.goto('/tools/credentials');
      await expect(page.getByText(/still sent to any host/)).toBeVisible();
      const row = page.getByRole('row').filter({ hasText: name });
      await expect(row).toContainText('Any host · review');
      await row.getByRole('button', { name: 'Manage' }).click();
      const drawer = page.getByRole('dialog', { name });
      await expect(drawer.getByText('Sent to any host')).toBeVisible();
      await expectNoAxeViolations(page, testInfo);
      const hosts = drawer.getByLabel('Hosts it may be sent to');
      // Only a host: no scheme, port or path.
      await hosts.fill('https://api.legacy.example/v1');
      await drawer.getByRole('button', { name: 'Save hosts' }).click();
      await expect(drawer.getByRole('alert')).toContainText('A host such as api.example.com');
      await hosts.fill('api.legacy.example\n*.uploads.legacy.example');
      await drawer.getByRole('button', { name: 'Save hosts' }).click();
      await expect(drawer.getByText('Sent to any host')).toHaveCount(0);
      await expect(drawer.getByRole('listitem').filter({ hasText: 'hosts' }).first()).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(row).toContainText('api.legacy.example, *.uploads.legacy.example');
      await expect(row).not.toContainText('Any host');
      await expectNoHorizontalOverflow(page);
      expect(await page.content()).not.toContain(value);
      expect(errors).toEqual([]);
    } finally {
      await setTheme(page, 'dark');
    }
  });
}

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
