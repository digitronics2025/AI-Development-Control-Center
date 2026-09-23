import { expect, test } from '@playwright/test';
import { setTheme, trackConsoleErrors } from './helpers';

/** Usage & Costs (design.md §7.10) against the demo orchestrator's simulated runs. */
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  await setTheme(page, 'dark');
  await page.close();
});

test.describe('Usage & Costs', () => {
  test('overview answers spend, tokens, budget and warnings, with an honest billing note', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Usage & Costs' }).click();
    await expect(page).toHaveURL(/\/usage$/);
    for (const label of ['Spend in range', 'Tokens', 'Cost per successful task', 'Budget left', 'Warnings']) {
      await expect(page.getByText(label, { exact: true }).and(page.locator('div')).first()).toBeVisible();
    }
    await expect(page.getByText('Simulated agents are in use')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Capacity & limits' })).toBeVisible();
    // Unsupported capacity is labelled, never guessed.
    await expect(page.getByText('Not exposed by this provider').first()).toBeVisible();

    // The trend chart is one keyboard stop; arrows read each value.
    const chart = page.getByRole('group', { name: /Spend per period/ });
    await chart.focus();
    await page.keyboard.press('End');
    await expect(page.getByRole('status').filter({ hasText: /attempt/ })).toBeVisible();

    // Range and tab live in the URL, so a reload or a bookmark reopens the same view.
    await page.getByRole('radio', { name: 'This month' }).click();
    await expect(page).toHaveURL(/range=month/);
    await page.getByRole('tab', { name: 'Models' }).click();
    await expect(page).toHaveURL(/tab=models/);
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('radio', { name: 'This month' })).toBeChecked();
    expect(errors).toEqual([]);
  });

  test('task ledger shows the cost flow and opens an attempt in a drawer that returns focus', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/usage?tab=tasks&range=month');
    await page.getByRole('table', { name: 'Task usage' }).getByRole('link').first().click();
    await expect(page).toHaveURL(/\/usage\/tasks\/TASK-\d+/);
    await expect(page.getByRole('heading', { name: 'Cost flow' })).toBeVisible();
    const open = page.getByRole('button', { name: /open attempt details/ }).first();
    await open.click();
    const drawer = page.getByRole('dialog', { name: 'Attempt' });
    await expect(drawer.getByRole('heading', { name: 'Usage by model' })).toBeVisible();
    await expect(drawer.getByText('Provider cost')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(open).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('budgets: add, see the meter and state, then delete with confirmation', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/usage?tab=budgets');
    await page.getByRole('button', { name: 'Add budget' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a budget' });
    await dialog.getByLabel('Amount in US dollars').fill('25');
    await dialog.getByRole('radio', { name: 'Warn only' }).click();
    await dialog.getByRole('button', { name: 'Add budget' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('All usage', { exact: true })).toBeVisible();
    await expect(page.getByText(/of \$25\.00 spent/)).toBeVisible();
    // A second budget for the same scope and period is refused, with the reason inline.
    await page.getByRole('button', { name: 'Add budget' }).click();
    await dialog.getByLabel('Amount in US dollars').fill('10');
    await dialog.getByRole('button', { name: 'Add budget' }).click();
    await expect(dialog.getByRole('alert')).toContainText('already exists');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Delete budget All usage' }).click();
    await page.getByRole('button', { name: 'Delete budget' }).click();
    await expect(page.getByText('No budgets yet')).toBeVisible();
    // The only console error is the refused duplicate this test asked for (HTTP 409).
    expect(errors.filter((e) => !e.includes('409'))).toEqual([]);
  });

  test('attempts export as CSV and the task inspector shows the live meter', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/usage?tab=events&range=month');
    await expect(page.getByText(/attempts? match/)).toBeVisible();
    await page.getByRole('button', { name: 'Export' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Attempts (CSV)' }).click();
    expect((await download).suggestedFilename()).toBe('usage-events.csv');

    await page.goto('/tasks/TASK-0001');
    await expect(page.getByRole('heading', { name: 'Usage', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Open cost ledger' }).click();
    await expect(page).toHaveURL(/\/usage\/tasks\/TASK-0001/);
    expect(errors).toEqual([]);
  });
});
