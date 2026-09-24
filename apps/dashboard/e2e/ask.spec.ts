import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoHorizontalOverflow, setTheme, trackConsoleErrors } from './helpers';

/**
 * Ask (design.md §7.3.2, docs/systems/ask.md) against the real orchestrator
 * with simulated agents: the palette's `?question`, the drawer, the page,
 * Stop, and Turn into task.
 */

const askDrawer = (page: Page) => page.getByRole('dialog').filter({ hasText: 'Read-only questions' });

async function askFromPalette(page: Page, question: string) {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type(`?${question}`);
  await expect(palette.getByRole('option', { name: `Ask: ${question}` })).toBeVisible();
  await page.keyboard.press('Enter');
  const drawer = askDrawer(page);
  await expect(drawer).toBeVisible();
  return drawer;
}

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  await setTheme(page, 'dark');
  await page.close();
});

test('?question in the palette asks at once, answers in the drawer, and opens in Ask', async ({ page }) => {
  const errors = trackConsoleErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/tasks');
  const question = `How do tasks run here? ${Date.now()}`;
  const drawer = await askFromPalette(page, question);
  await expect(drawer.getByText(`Simulated answer to: ${question}`)).toBeVisible();
  await expect(drawer.getByRole('log', { name: 'Ask conversation' })).toContainText(question);
  await drawer.getByRole('button', { name: 'Open in Ask' }).click();
  await expect(page).toHaveURL(/\/ask\?thread=/);
  await expect(page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: question })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText(`Simulated answer to: ${question}`)).toBeVisible();
  expect(errors, 'console errors').toEqual([]);
});

test('a new question on the page reads the chosen repository, and Turn into task fills New Task', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/ask');
  await page.getByRole('button', { name: 'New question' }).first().click();
  const conversation = page.getByRole('region', { name: 'New question' });
  await conversation.getByRole('combobox', { name: 'Repository' }).click();
  const firstRepository = page.getByRole('option').nth(1);
  const repositoryName = (await firstRepository.innerText()).split('\n')[0]!.trim();
  await firstRepository.click();
  await conversation.getByLabel('Ask a question').fill('Where is the README?');
  await conversation.getByLabel('Ask a question').press('Enter');
  await expect(page).toHaveURL(/\/ask\?thread=/);
  await expect(page.getByText(`Repository: ${repositoryName}`)).toBeVisible();
  await page.getByRole('button', { name: 'Turn into task' }).click();
  await expect(page).toHaveURL(/\/tasks\/new$/);
  await expect(page.getByLabel('Description')).toHaveValue(/^Where is the README\?[\s\S]*Context from the Ask conversation/);
});

test('Stop ends an answer being written', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const drawer = await askFromPalette(page, 'Take your time [sim:slow]');
  await expect(drawer.getByRole('button', { name: 'Stop' })).toBeVisible();
  await drawer.getByRole('button', { name: 'Stop' }).click();
  await expect(drawer.getByText('Stopped')).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Stop' })).toBeHidden();
});

for (const theme of ['dark', 'light'] as const) {
  test(`a conversation meets WCAG 2.2 AA and fits a phone in the ${theme} theme`, async ({ page }, testInfo) => {
    await page.goto('/');
    await setTheme(page, theme);
    for (const size of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await page.goto('/ask');
      await page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: /How do tasks run here/ }).first().click();
      await expect(page.getByText(/Simulated answer to:/).first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectNoAxeViolations(page, testInfo);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const drawer = await askFromPalette(page, `Theme check ${theme}`);
    await expect(drawer.getByText(`Simulated answer to: Theme check ${theme}`)).toBeVisible();
    await expectNoAxeViolations(page, testInfo);
  });
}

test('an answer lists what it looked up, including a refused lookup', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const stamp = Date.now();
  const drawer = await askFromPalette(page, `Tasks please ${stamp} [sim:lookup:controlcenter.tasks:{"limit":3}] [sim:lookup:fs.write:{"path":"x","content":"y"}]`);
  await expect(drawer.getByText(`Simulated answer to: Tasks please ${stamp}`)).toBeVisible();
  const sources = drawer.getByText('Sources · 2 lookups');
  await expect(sources).toBeVisible();
  await sources.click();
  const lookups = drawer.getByRole('list', { name: 'Lookups' });
  await expect(lookups.getByRole('listitem').filter({ hasText: 'Tasks' })).toBeVisible();
  await expect(lookups.getByRole('listitem').filter({ hasText: 'fs.write' })).toContainText('Refused');
});

test('sources that are not set up are offered with the way to set them up', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/ask');
  await page.getByRole('button', { name: 'New question' }).first().click();
  const conversation = page.getByRole('region', { name: 'New question' });
  await expect(conversation.getByText('Looks at: Control Center · personal data hidden')).toBeVisible();
  await conversation.getByRole('button', { name: /Options/ }).click();
  await expect(conversation.getByRole('checkbox', { name: 'Control Center' })).toBeDisabled();
  await expect(conversation.getByRole('checkbox', { name: 'Cloudflare' })).toBeDisabled();
  await conversation.getByRole('link', { name: 'Set up in Settings' }).first().click();
  await expect(page).toHaveURL(/\/settings\/ask$/);
  await page.getByRole('button', { name: 'Check access' }).click();
  const results = page.getByRole('list', { name: 'Access check' });
  await expect(results).toContainText('Control Center: Ready');
  await expect(results).toContainText('Choose a read-only GitHub key');
});
