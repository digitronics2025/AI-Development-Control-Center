import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, expectNoAxeViolations, expectNoHorizontalOverflow, setTheme, trackConsoleErrors } from './helpers';

/**
 * Lead time (docs/plans/LEAD_TIME_PLAN.md): the task Overview's "Where the
 * time went" card, and Settings → Notifications → Phone alerts with Send a
 * test. The test alert goes to a port that refuses connections, so nothing
 * leaves the machine; delivery itself is covered by the orchestrator's unit
 * tests with a stand-in messenger. In both themes and at phone width.
 */

let completed = '';
const CREDENTIAL = 'e2e-messenger-token';

interface Settings { notifications: { approvals: boolean; failures: boolean; completions: boolean; phone: Record<string, string> } }

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  const { items } = await api<{ items: Array<{ id: string; status: string }> }>(page, 'GET', '/api/tasks?limit=200');
  completed = items.find((t) => t.status === 'COMPLETED')!.id;
  // Assembled at runtime so no credential-shaped literal is committed.
  await api(page, 'POST', '/api/credentials', { name: CREDENTIAL, kind: 'http', description: 'e2e', repositoryIds: null, value: ['e2e', randomUUID()].join('-') }).catch(() => undefined);
  await page.close();
});

for (const theme of ['dark', 'light'] as const) {
  test.describe(`lead time in the ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await setTheme(page, theme);
    });

    test('a completed task says where its time went', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/tasks/${completed}`);
      const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Where the time went', exact: true }) }).last();
      await expect(card.getByText('Agents, first pass')).toBeVisible();
      await expect(card.getByText('Checks')).toBeVisible();
      await expect(card.getByText('Waiting for you')).toBeVisible();
      await expect(card.getByText('Between stages')).toBeVisible();
      await expectNoAxeViolations(page, testInfo);
      expect(errors).toEqual([]);
    });

    test('phone alerts are set up in Settings and Send a test says what happened', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      const before = await api<Settings>(page, 'GET', '/api/settings');
      try {
        await page.goto('/settings/notifications');
        const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Phone alerts', exact: true }) }).last();
        await expect(section.getByText(/Off until the address, the token and the recipient are all set/)).toBeVisible();
        await expect(section.getByRole('button', { name: 'Send a test' })).toBeDisabled();
        // Port 9 refuses connections: the test alert cannot leave the machine.
        await section.getByLabel('Messenger address').fill('https://127.0.0.1:9');
        await section.getByRole('combobox', { name: 'Messenger token' }).click();
        await page.getByRole('option', { name: CREDENTIAL }).click();
        await section.getByLabel('Recipient').fill('owner@example.com');
        // Unsaved edits: the test would use the saved settings, so it waits.
        await expect(section.getByRole('button', { name: 'Send a test' })).toBeDisabled();
        await page.getByRole('button', { name: 'Save Changes' }).click();
        await expect(section.getByRole('button', { name: 'Send a test' })).toBeEnabled();
        await section.getByRole('button', { name: 'Send a test' }).click();
        await expect(section.getByText('Not sent: the messenger could not be reached.')).toBeVisible({ timeout: 20_000 });
        await expectNoAxeViolations(page, testInfo);
        expect(errors).toEqual([]);
      } finally {
        // Phone alerts off again, so no other file's tasks try to send.
        await api(page, 'PATCH', '/api/settings', { notifications: before.notifications });
      }
    });

    test('both fit a phone', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/tasks/${completed}`);
      await expect(page.getByText('Where the time went').first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.goto('/settings/notifications');
      await expect(page.getByRole('heading', { name: 'Phone alerts' })).toBeVisible();
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
