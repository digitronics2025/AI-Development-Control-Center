import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoHorizontalOverflow, trackConsoleErrors, VIEWPORTS } from '../e2e/helpers';
import { cloudApi, nodeApi, state } from './helpers';

/**
 * The cloud user flow (CLOUD_CONTROL_PLAN §7 "Playwright cloud-mode E2E"):
 * one browser signed in through (test) Access, the dashboard served by the
 * Worker, and a real orchestrator paired as the node. Runs in order: the last
 * test revokes the node.
 */
test.describe.configure({ mode: 'serial' });

const errorsOk = (errors: string[]) => errors.filter((e) => !/Failed to load resource: the server responded with a status of (409|410|503)/.test(e));

/** The node link survives Worker restarts by reconnecting; node-dependent steps wait for it. */
async function nodeOnline(page: Page) {
  await expect(page.getByRole('status').filter({ hasText: 'E2E node online' }).first()).toBeVisible({ timeout: 30_000 });
}

async function setTheme(page: Page, theme: 'dark' | 'light') {
  const s = state();
  const res = await page.request.patch(`${s.cloudUrl}/api/settings`, { data: { theme }, headers: { origin: s.cloudUrl } });
  expect(res.ok(), `theme: ${res.status()}`).toBe(true);
}

test('1–2: the cloud dashboard opens without any local token and shows the paired node online', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('meta[name="acc-token"]'))).toBeNull();
  await expect(page.getByRole('combobox', { name: 'Node shown' })).toContainText('E2E node · Online');
  await expect(page.getByRole('status').filter({ hasText: 'E2E node online' }).first()).toBeVisible();
  await page.getByRole('link', { name: 'Nodes' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Nodes' })).toBeVisible();
  const row = page.getByRole('table', { name: 'Paired nodes' }).getByRole('row').filter({ hasText: 'E2E node' });
  await expect(row).toContainText('Online');
  await expect(row).toContainText('5');
  // The local-only settings section does not exist here.
  await page.goto('/settings');
  await expect(page.getByRole('link', { name: 'Remote access' })).toHaveCount(0);
  expect(errorsOk(errors)).toEqual([]);
});

test('3–4, 8: a task created in the cloud runs on the node through every stage, with logs and artifacts', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  // docs-site is held by the seeded TASK-0005 (waiting for the user); free it from the cloud.
  await cloudApi(page, 'POST', '/api/tasks/TASK-0005/cancel', {});
  await page.goto('/tasks/new');
  await page.getByRole('combobox', { name: 'Repository' }).click();
  await page.getByRole('searchbox').fill('docs-site');
  await page.keyboard.press('Enter');
  await page.getByLabel('Description').fill('Tidy the README headings from the cloud.');
  await page.getByRole('radio', { name: 'Autopilot' }).click();
  await expect(page.getByRole('combobox', { name: 'Run on' })).toContainText('E2E node (shown)');
  await page.getByRole('button', { name: 'Start Task' }).click();
  await expect(page).toHaveURL(/\/tasks\/TASK-\d+/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { level: 1, name: 'Tidy the README headings from the cloud.' })).toBeVisible();
  const stages = page.getByRole('list', { name: 'Workflow stages' });
  for (const name of ['Investigate', 'Plan', 'Implement', 'Test', 'Review']) await expect(stages).toContainText(name);
  await expect(page.getByText(/Completed|Failed|Waiting for you/, { exact: false }).first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole('tab', { name: 'Logs' }).click();
  await page.getByRole('radio', { name: 'Developer' }).click();
  await expect(page.getByRole('log', { name: 'Execution output' })).toBeVisible();
  await page.getByRole('tab', { name: /Artifacts/ }).click();
  await expect(page.getByRole('button', { name: /request\.md|final-report\.md/ }).first()).toBeVisible();
  expect(errorsOk(errors)).toEqual([]);
});

test('5–6: Chairman chat, pause, directive and resume from the cloud', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const repos = await (await page.request.get(`${state().cloudUrl}/api/repositories`)).json();
  const mobile = (repos as Array<{ id: string; name: string }>).find((r) => r.name === 'mobile-app')!;
  // mobile-app is held by the seeded TASK-0004 (usage limit); free it first.
  await cloudApi(page, 'POST', '/api/tasks/TASK-0004/cancel', {});
  const created = await cloudApi<{ id: string }>(page, 'POST', '/api/tasks', { repositoryId: mobile.id, workflowId: 'normal-development', mode: 'autopilot', description: 'Long cloud job [sim:slow]' });
  await page.goto(`/tasks/${created.id}`);
  await expect(page.getByRole('button', { name: 'Pause' }).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Pause' }).first().click();
  await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const inspector = page.getByRole('complementary', { name: 'Task inspector' });
  await inspector.getByLabel('Directive').fill('Keep the webhook signature check.');
  await inspector.getByRole('button', { name: 'Add directive' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Directive queued' })).toBeVisible();
  await page.getByRole('button', { name: /^Chairman — / }).click();
  const drawer = page.getByRole('dialog', { name: 'Chairman' });
  await drawer.getByLabel('Message the Chairman').fill('What is the current status?');
  await drawer.getByLabel('Message the Chairman').press('Enter');
  await expect(drawer.getByLabel('Message the Chairman')).toHaveValue('');
  await expect(drawer.getByRole('log', { name: 'Chairman conversation' })).toContainText('What is the current status?');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Resume' }).first().click();
  await expect(page.getByRole('button', { name: 'Pause' }).first()).toBeVisible({ timeout: 30_000 });
  // Reroute the running stage to the other agent.
  const rerouted = await cloudApi<{ assignments: Record<string, { agentId: string }> }>(page, 'POST', `/api/tasks/${created.id}/reroute`, { agentId: 'claude', reason: 'Try the other agent' });
  expect(Object.values(rerouted.assignments).some((a) => a.agentId === 'claude')).toBe(true);
  await inspector.getByRole('button', { name: 'Cancel task…' }).click();
  await page.getByRole('button', { name: `Cancel ${created.id}` }).click();
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const cmds = await cloudApi<Array<{ op: string; status: string }>>(page, 'GET', '/api/cloud/commands?limit=50');
  for (const op of ['task.pause', 'task.directive', 'task.reroute', 'task.resume', 'task.cancel', 'chairman.message']) expect(cmds.some((c) => c.op === op && c.status === 'succeeded'), op).toBe(true);
});

test('7: an approval is decided in the cloud, bound to what the user saw', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/approvals');
  await nodeOnline(page);
  const card = page.getByRole('article').filter({ hasText: 'Add Stripe webhook retries' });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole('button', { name: 'Approve plan' }).click();
  await expect(page.getByRole('article').filter({ hasText: 'Add Stripe webhook retries' })).toHaveCount(0, { timeout: 30_000 });
  const cmds = await cloudApi<Array<{ op: string; status: string }>>(page, 'GET', '/api/cloud/commands?limit=50');
  expect(cmds.find((c) => c.op === 'approval.approve')?.status).toBe('succeeded');
});

test('9–10: usage and Source Control read and write through the cloud', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/usage');
  await nodeOnline(page);
  await expect(page.getByText('Spend in range')).toBeVisible();
  await page.goto('/source-control');
  await expect(page.getByRole('combobox', { name: 'Repository' })).toHaveText(/api-gateway/);
  const group = (name: string) => page.getByRole('list', { name: new RegExp(`^${name}`) });
  await expect(group('Changes')).toContainText('README.md', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Stage README.md' }).click();
  await expect(group('Staged')).toContainText('README.md');
  await page.getByRole('button', { name: 'Unstage README.md' }).click();
  await expect(group('Changes')).toContainText('README.md');
  expect(errorsOk(errors)).toEqual([]);
});

test('11: the browser loses its connection and comes back without losing anything', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  let drop = false;
  const live: Array<{ close: () => Promise<void> }> = [];
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (drop) return void ws.close();
    ws.connectToServer();
    live.push(ws);
  });
  const response = await page.goto('/tasks');
  expect(response?.status(), await response?.text().catch(() => '')).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: 'E2E node online' }).first()).toBeVisible();
  drop = true;
  for (const ws of live) await ws.close();
  await expect(page.getByText('Cloud disconnected. Showing last known state.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'New Task' })).toBeDisabled();
  drop = false;
  await expect(page.getByText('Cloud disconnected. Showing last known state.')).toBeHidden({ timeout: 45_000 });
  await expect(page.getByRole('status').filter({ hasText: 'E2E node online' }).first()).toBeVisible();
  // Reconciled after the gap: the list still answers live.
  await expect(page.getByText('TASK-0001', { exact: true }).first()).toBeVisible();
});

test('12–13: the node goes away — history stays readable, actions stop — and comes back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/tasks');
  const first = page.getByText('TASK-0001', { exact: true }).first();
  await expect(first).toBeVisible();
  // The operator turns remote control off on the machine itself.
  await nodeApi('PATCH', '/api/remote', { enabled: false });
  await expect(page.getByText('E2E node is offline. Showing the history saved in the cloud.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'New Task' })).toBeEnabled(); // queueing stays possible
  await page.goto('/tasks/TASK-0001');
  await expect(page.getByRole('list', { name: 'Workflow stages' })).toBeVisible({ timeout: 20_000 });
  await page.goto('/settings');
  await expect(page.getByText(/offline|needs a live node/i).first()).toBeVisible();
  await nodeApi('PATCH', '/api/remote', { enabled: true });
  await expect(page.getByText('E2E node is offline. Showing the history saved in the cloud.')).toBeHidden({ timeout: 45_000 });
});

test('15: responsive and accessible in both themes at every viewport', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  for (const theme of ['dark', 'light'] as const) {
    await page.goto('/');
    await setTheme(page, theme);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      for (const path of ['/nodes', '/', '/tasks/TASK-0001']) {
        await page.goto(path);
        await expect(page.locator('main')).toBeVisible();
        // Realtime keeps a socket open, so the network never idles: wait for the page to settle instead.
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        // Controls enable once the node is known online; scan after that, not mid-transition.
        await expect(page.getByRole('button', { name: 'New Task' })).toBeEnabled();
        await page.waitForTimeout(400);
        await expectNoHorizontalOverflow(page);
        if (viewport.name === 'desktop' || viewport.name === 'mobile') await expectNoAxeViolations(page, testInfo);
      }
    }
  }
  await setTheme(page, 'dark');
});

test('14: revoking the node stops all control at once', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/nodes');
  const row = page.getByRole('table', { name: 'Paired nodes' }).getByRole('row').filter({ hasText: 'E2E node' });
  await row.getByRole('button', { name: 'Revoke' }).click();
  const dialog = page.getByRole('dialog', { name: 'Revoke E2E node?' });
  await dialog.getByRole('textbox').fill('REVOKE');
  await dialog.getByRole('button', { name: 'Revoke node' }).click();
  await expect(row).toContainText('Revoked', { timeout: 20_000 });
  await expect.poll(async () => (await nodeApi<{ state: string }>('GET', '/api/remote')).state, { timeout: 30_000 }).toBe('revoked');
  const refused = await page.request.post(`${state().cloudUrl}/api/tasks/TASK-0001/pause`, { data: {}, headers: { origin: state().cloudUrl, 'x-acc-node': state().nodeId } });
  expect(refused.status()).toBe(403);
});
