import { expect, test } from '@playwright/test';
import { api, setTheme, trackConsoleErrors } from './helpers';

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  await setTheme(page, 'dark');
  await page.close();
});

test.describe('New Task (design.md §7.2, §18)', () => {
  test('a normal task starts without opening Advanced, keyboard only', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/tasks/new');
    // Validation is inline and keyboard-reachable.
    await page.getByRole('button', { name: 'Start Task' }).click();
    await expect(page.getByText('Choose the repository this task works in.')).toBeVisible();
    await expect(page.getByText('Describe what the task should achieve.')).toBeVisible();

    await page.getByRole('combobox', { name: 'Repository' }).click();
    await page.getByRole('searchbox').fill('billing');
    await page.keyboard.press('Enter');
    await page.getByLabel('Description').fill('Add an audit log for refunds.');
    await expect(page.getByText('Advanced options')).toBeVisible();
    await expect(page.getByLabel('Title')).toBeHidden();
    await page.keyboard.press('Control+Enter');
    await expect(page).toHaveURL(/\/tasks\/TASK-\d+/);
    await expect(page.getByRole('heading', { level: 1, name: 'Add an audit log for refunds.' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('Task Detail (design.md §7.3, §18)', () => {
  test('current stage, assignment, tabs in order and inspector are present', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/tasks/TASK-0001');
    await expect(page.getByRole('list', { name: 'Workflow stages' })).toBeVisible();
    const tabs = page.getByRole('tablist', { name: 'Task sections' }).getByRole('tab');
    await expect(tabs).toHaveText([/Overview/, /Activity/, /Changes/, /Tests/, /Artifacts/, /Logs/, /Execution/]);
    await expect(page.getByRole('complementary', { name: 'Task inspector' })).toBeVisible();

    await page.getByRole('tab', { name: 'Changes' }).click();
    await expect(page).toHaveURL(/tab=changes/);
    await expect(page.getByRole('list', { name: 'Changed files' })).toBeVisible();
    await page.getByRole('tab', { name: /Tests/ }).click();
    await page.getByRole('button', { name: /unit tests/ }).first().click();
    await expect(page.getByRole('log', { name: 'Command output' })).toContainText('12 passed');
    await page.getByRole('tab', { name: 'Logs' }).click();
    await page.getByRole('radio', { name: 'Developer' }).click();
    await expect(page.getByRole('log', { name: 'Execution output' })).toBeVisible();
    await page.getByRole('radio', { name: 'Simple' }).click();
    // Tab choice survives a realtime refresh and a reload (URL state).
    await page.getByRole('tab', { name: 'Artifacts' }).click();
    await page.reload();
    await expect(page.getByRole('tab', { name: /Artifacts/ })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'final-report.md', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'final-report.md' })).toContainText('TASK COMPLETED');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page.getByRole('button', { name: 'final-report.md', exact: true })).toBeFocused();
  });

  test('pause, directive and resume on a running task; cancel needs confirmation', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const repos = await api<Array<{ id: string; name: string }>>(page, 'GET', '/api/repositories');
    const mobile = repos.find((r) => r.name === 'mobile-app')!;
    const created = await api<{ id: string }>(page, 'POST', '/api/tasks', {
      repositoryId: mobile.id,
      workflowId: 'normal-development',
      mode: 'autopilot',
      description: 'Long running job [sim:slow]',
    });
    await page.goto(`/tasks/${created.id}`);
    // mobile-app is held by TASK-0004 (usage limit); free it first.
    await api(page, 'POST', '/api/tasks/TASK-0004/cancel');
    await expect(page.getByRole('button', { name: 'Pause' }).first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: 'Pause' }).first().click();
    await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Resume' }).first()).toBeVisible();

    const inspector = page.getByRole('complementary', { name: 'Task inspector' });
    await inspector.getByLabel('Directive').fill('Do not modify the D1 schema.');
    await inspector.getByRole('button', { name: 'Add directive' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Directive queued' })).toBeVisible();
    await page.getByRole('button', { name: 'Resume' }).first().click();
    await expect(page.getByRole('button', { name: 'Pause' }).first()).toBeVisible({ timeout: 20_000 });

    await inspector.getByRole('button', { name: 'Cancel task…' }).click();
    const dialog = page.getByRole('dialog', { name: `Cancel ${created.id}?` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await expect(dialog).toBeHidden();
    await inspector.getByRole('button', { name: 'Cancel task…' }).click();
    await page.getByRole('button', { name: `Cancel ${created.id}` }).click();
    await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  });
});

test.describe('Approvals (design.md §7.4)', () => {
  test('plan review uses explicit labels and continues the task', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/approvals');
    const card = page.getByRole('article').filter({ hasText: 'TASK-0003' });
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: 'Approve plan' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Request changes' })).toBeVisible();
    for (const vague of ['OK', 'Continue', 'Yes']) await expect(page.getByRole('button', { name: vague, exact: true })).toHaveCount(0);
    await card.getByRole('button', { name: 'Approve plan' }).click();
    await expect(page.getByRole('article').filter({ hasText: 'TASK-0003' })).toHaveCount(0);
    await page.goto('/tasks/TASK-0003');
    await expect(page.getByRole('list', { name: 'Workflow stages' })).toContainText('Implement');
  });
});

test.describe('Global shell (design.md §3, §11, §15)', () => {
  test('command palette opens with Ctrl+K, filters, navigates and returns focus on Escape', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await page.keyboard.type('agents');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/agents$/);
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  });

  test('skip link and keyboard navigation reach main content', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
  });

  test('collapsed navigation keeps accessible names', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    for (const label of ['Home', 'Tasks', 'Workflows', 'Agents', 'Repositories', 'Approvals', 'Settings']) {
      await expect(nav.getByRole('link', { name: new RegExp(`^${label}`) })).toBeVisible();
    }
  });

  test('mobile navigation opens as a drawer', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('dialog', { name: 'Navigation' }).getByRole('link', { name: /^Repositories/ }).click();
    await expect(page).toHaveURL(/\/repositories$/);
    await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeHidden();
  });

  test('shows a persistent banner and disables task actions when the orchestrator is unreachable', async ({ page }) => {
    await page.routeWebSocket(/\/ws/, (ws) => ws.close());
    await page.goto('/');
    await expect(page.getByRole('alert').filter({ hasText: 'Cannot reach the orchestrator' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Task' })).toBeDisabled();
  });
});

test.describe('Workflows (design.md §7.5)', () => {
  test('built-ins are read-only; a copy validates inline and blocks invalid saves', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/workflows/quick-change');
    await expect(page.getByText('Built-in workflows are read-only')).toBeVisible();
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await expect(page).toHaveURL(/quick-change-copy/);
    await page.getByRole('button', { name: /^1\.\s*Implement/ }).click();
    const key = page.getByLabel('Key');
    await key.fill('Bad Key');
    await expect(page.getByText(/validation error/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await key.fill('build');
    await expect(page.getByText(/validation error/)).toBeHidden();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Custom · v2')).toBeVisible();
  });
});

test.describe('Settings (design.md §7.8, §18)', () => {
  test('Subscription Only is the marked default and API mode needs a typed confirmation', async ({ page }) => {
    await page.goto('/settings/billing');
    await expect(page.getByRole('radio', { name: /Subscription Only/ })).toBeChecked();
    await expect(page.getByText('Safe default')).toBeVisible();
    // The radio opens a confirmation instead of switching immediately.
    await page.getByRole('radio', { name: /Explicit API Mode/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Switch to Explicit API Mode?' });
    await expect(dialog.getByRole('button', { name: 'Allow API billing' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Keep Subscription Only' }).click();
    await expect(page.getByRole('radio', { name: /Subscription Only/ })).toBeChecked();
  });
});
