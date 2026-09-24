import { expect, test } from '@playwright/test';
import { setTheme, trackConsoleErrors } from './helpers';

/**
 * Learning (design.md §7.13) against the demo's learning-lab task, which
 * passed its checks only after two rounds of fixing: the simulated Chairman's
 * review turned that into one lesson it is still watching.
 */
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  await setTheme(page, 'dark');
  await page.close();
});

test.describe('Learning', () => {
  test('shows what the review found, adopts it on request, and undoes it', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Learning' }).click();
    await expect(page).toHaveURL(/\/learning$/);
    await expect(page.getByRole('heading', { name: 'Learning', level: 1 })).toBeVisible();
    for (const label of ['Live improvements', 'Needs you', 'Watching', 'Tasks reviewed']) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }

    // The review that produced it, linked to its task.
    await page.getByRole('tab', { name: 'Reviews' }).click();
    await expect(page).toHaveURL(/tab=reviews/);
    const reviews = page.getByRole('table', { name: 'Task reviews, newest first' });
    const reviewed = reviews.getByRole('row').filter({ has: page.getByRole('link', { name: /Add input validation to the signup form/ }) });
    await expect(reviewed.getByText('Reviewed', { exact: true })).toBeVisible();
    await expect(reviewed.getByText('Chairman agent')).toBeVisible();

    // The finding waits for a second task; the operator can decide now.
    await page.getByRole('tab', { name: /^Findings/ }).click();
    const watching = page.getByRole('region', { name: 'Watching' });
    // Other demo tasks may be watched too; this one is learning-lab's.
    const row = watching.getByRole('listitem').filter({ hasText: 'Check the whole suite before handing over' }).filter({ hasText: 'learning-lab' });
    await expect(row.getByText(/acts after 2/)).toBeVisible();
    await expect(row.getByText(/^Proposed: Lesson:/)).toBeVisible();
    await row.getByRole('button', { name: 'Do it now' }).click();
    await expect(page.getByText('Done — it is now on trial')).toBeVisible();

    await page.getByRole('tab', { name: 'Improvements' }).click();
    const improvement = page.getByRole('listitem').filter({ hasText: 'Run the full test command once before handing over' }).filter({ hasText: 'learning-lab' });
    await expect(improvement.getByText('On trial')).toBeVisible();
    await expect(improvement.getByText('Tried on 0 of 3 tasks · came back no times')).toBeVisible();
    await improvement.getByRole('button', { name: 'Undo' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Undo this improvement?' }).or(page.getByRole('dialog', { name: 'Undo this improvement?' }));
    await expect(dialog.getByText(/will not make this change again on its own/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Undo' }).click();
    await expect(improvement.getByText('Undone', { exact: true })).toBeVisible();
    await expect(improvement.getByRole('button', { name: 'Undo' })).toHaveCount(0);

    await page.getByRole('tab', { name: 'Activity' }).click();
    await expect(page.getByText(/You undid "Run the full test command/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('settings explain what acting on its own means', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/settings/learning');
    await expect(page.getByRole('heading', { name: 'Learning', level: 2 })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Make it on its own' })).toBeChecked();
    await expect(page.getByText(/Programs come only from a reviewed list/)).toBeVisible();
    await page.getByRole('radio', { name: 'Ask me first' }).click();
    await expect(page.getByText(/wait under Learning → Needs you/)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
