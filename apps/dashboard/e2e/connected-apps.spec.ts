import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { api, expectNoAxeViolations, expectNoHorizontalOverflow, setTheme, trackConsoleErrors } from './helpers';

/**
 * Tools → Connected apps (docs/systems/connected-apps.md, design.md §7.11)
 * against the real orchestrator. Pairing is finished the way Private Browser
 * finishes it: a non-browser request to /api/connected-app/pair with the code
 * the dialog shows (Playwright's request context sends no Origin).
 */

const nonce = () => randomBytes(18).toString('base64url');

async function redeem(page: Page, code: string): Promise<{ appId: string; token: string }> {
  const res = await page.request.post('/api/connected-app/pair', { data: { code, name: 'Private Browser', nonce: nonce() } });
  expect(res.status()).toBe(201);
  return (await res.json()) as { appId: string; token: string };
}

for (const theme of ['dark', 'light'] as const) {
  test(`pairs, sets the start mode and disconnects Private Browser (${theme})`, async ({ page }, testInfo) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await setTheme(page, theme);
    await page.goto('/tools/apps');
    await expect(page.getByRole('tab', { name: 'Connected apps' })).toHaveAttribute('aria-selected', 'true');

    await page.getByRole('button', { name: 'Pair Private Browser' }).click();
    const dialog = page.getByRole('dialog', { name: 'Pair Private Browser' });
    await dialog.getByRole('button', { name: 'Make a pairing code' }).click();
    const shown = (await dialog.getByTestId('pairing-code').innerText()).replace(/\s/g, '');
    expect(shown).toMatch(/^\d{8}$/);
    await expect(dialog.getByTestId('pairing-fingerprint')).toHaveText(/^([0-9A-F]{4} ){7}[0-9A-F]{4}$/);
    await expect(dialog).toContainText('Works once · expires in');
    await expectNoAxeViolations(page, testInfo);
    const paired = await redeem(page, shown);
    await dialog.getByRole('button', { name: 'Close' }).first().click();

    const table = page.getByRole('table', { name: 'Connected apps' });
    const row = table.getByRole('row').filter({ has: page.getByText('Private Browser', { exact: true }) }).filter({ hasText: 'Connected' }).first();
    await expect(row).toBeVisible();
    await row.getByRole('radio', { name: 'Autopilot' }).click();
    await expect.poll(async () => (await api<{ apps: Array<{ id: string; defaultMode: string }> }>(page, 'GET', '/api/connected-apps')).apps.find((a) => a.id === paired.appId)?.defaultMode).toBe('autopilot');
    await expectNoHorizontalOverflow(page);

    await row.getByRole('button', { name: 'Disconnect' }).click();
    const confirm = page.getByRole('dialog', { name: /Disconnect Private Browser/ });
    await expect(confirm).toContainText('Tasks it already created stay');
    await confirm.getByRole('button', { name: 'Disconnect' }).click();
    await expect(table.getByText('Disconnected').first()).toBeVisible();
    const after = await page.request.get('/api/connected-app/tasks', { headers: { authorization: `Bearer ${paired.token}` } });
    expect(after.status()).toBe(401);
    expect(errors).toEqual([]);
  });
}

test('a task Private Browser sent carries its badge in the header and the task list', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await setTheme(page, 'dark');
  const offer = await api<{ code: string }>(page, 'POST', '/api/connected-apps/pairings', { kind: 'private-browser' });
  const paired = await redeem(page, offer.code);
  const repos = await api<Array<{ id: string }>>(page, 'GET', '/api/repositories');
  const created = await page.request.post('/api/connected-app/tasks', {
    headers: { authorization: `Bearer ${paired.token}` },
    data: { requestId: nonce(), repositoryId: repos[0]!.id, note: 'Badge check from the browser', sourceUrl: 'http://127.0.0.1:5173/cart', evidence: '{"console":[{"level":"error","message":"boom"}]}' },
  });
  expect(created.status()).toBe(201);
  const task = (await created.json()) as { id: string };
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Badge check from the browser');
  await expect(page.getByText('From Private Browser').first()).toBeVisible();
  await page.goto('/');
  await expect(page.locator('li').filter({ hasText: task.id }).getByText('From Private Browser')).toBeVisible();
  expect(errors).toEqual([]);
});
