import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'compact', width: 1280, height: 800 },
  { name: 'narrow-desktop', width: 1024, height: 768 },
  { name: 'narrow-panel', width: 768, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

export const PAGES = [
  { name: 'home', path: '/', ready: 'Active Tasks' },
  { name: 'tasks', path: '/tasks', ready: 'Every task on this machine' },
  { name: 'task-detail', path: '/tasks/TASK-0001', ready: 'Completion report' },
  { name: 'new-task', path: '/tasks/new', ready: 'Start Task' },
  { name: 'approvals', path: '/approvals', ready: 'Approvals' },
  { name: 'workflows', path: '/workflows/normal-development', ready: 'Stages' },
  { name: 'agents', path: '/agents', ready: 'Re-check all' },
  { name: 'repositories', path: '/repositories', ready: 'Add repository' },
  { name: 'source-control', path: '/source-control', ready: 'Recent Git operations' },
  { name: 'source-control-history', path: '/source-control?tab=history', ready: 'End of history' },
  { name: 'settings-billing', path: '/settings/billing', ready: 'Billing Mode' },
  { name: 'tools', path: '/tools', ready: 'Check all' },
  { name: 'tools-policy', path: '/tools/policy', ready: 'Give agents the Control Center tools' },
  { name: 'tools-credentials', path: '/tools/credentials', ready: 'Values are write-only' },
  { name: 'task-execution', path: '/tasks/TASK-0001?tab=execution', ready: 'Tool calls' },
  { name: 'usage-overview', path: '/usage', ready: 'Spend in range' },
  { name: 'usage-models', path: '/usage?tab=models', ready: 'Price list' },
  { name: 'usage-providers', path: '/usage?tab=providers', ready: 'Re-check readings' },
  { name: 'usage-budgets', path: '/usage?tab=budgets', ready: 'Add budget' },
  { name: 'usage-events', path: '/usage?tab=events', ready: 'match' },
  { name: 'usage-task', path: '/usage/tasks/TASK-0001', ready: 'Cost flow' },
  { name: 'learning', path: '/learning', ready: 'Tasks reviewed' },
  { name: 'learning-findings', path: '/learning?tab=findings', ready: 'Proposed:' },
  { name: 'settings-learning', path: '/settings/learning', ready: 'When a change is worth making' },
] as const;

/** Console errors fail the test; collected from page load onwards. */
export function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, 'page-level horizontal scroll (design.md §6)').toBeLessThanOrEqual(clientWidth + 1);
}

export async function expectNoAxeViolations(page: Page, testInfo: TestInfo): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  if (results.violations.length) {
    await testInfo.attach('axe-violations.json', { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
  }
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(summary, 'axe WCAG 2.2 AA violations').toEqual([]);
}

export async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const token = await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="acc-token"]')?.content ?? '');
  const res = await page.request.patch('/api/settings', { data: { theme }, headers: { authorization: `Bearer ${token}` } });
  expect(res.ok()).toBe(true);
  // The page learns the new setting over the WebSocket; checks made before it is painted see the old theme.
  await page.waitForFunction((t) => document.documentElement.dataset.theme === t && document.documentElement.dataset.themeSwitching === undefined, theme);
}

export async function api<T = unknown>(page: Page, method: 'GET' | 'POST' | 'PATCH', path: string, data?: unknown): Promise<T> {
  const token = await page.evaluate(() => document.querySelector<HTMLMetaElement>('meta[name="acc-token"]')?.content ?? '');
  const res = await page.request.fetch(path, { method, data, headers: { authorization: `Bearer ${token}` } });
  expect(res.ok(), `${method} ${path}: ${res.status()}`).toBe(true);
  return (res.status() === 204 ? null : await res.json()) as T;
}
