import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, setTheme, trackConsoleErrors } from './helpers';

/**
 * Installable app and long-lived phone sessions (docs/systems/dashboard.md
 * "Installable app"): the manifest and icons, touch use at phone width, a
 * socket that dies without closing, and a page left open across a release.
 */

test.describe('Installable app', () => {
  test('the manifest parses, names the app and its icons all load as PNG', async ({ page, request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/application\/manifest\+json/);
    const manifest = (await res.json()) as { id: string; start_url: string; scope: string; display: string; name: string; short_name: string; icons: Array<{ src: string; sizes: string; purpose: string }> };
    expect(manifest).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone', short_name: 'Control Center' });
    const sizes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
    for (const icon of [...manifest.icons.map((i) => i.src), '/icons/apple-touch-icon.png']) {
      const r = await request.get(icon);
      expect(r.status(), icon).toBe(200);
      expect(r.headers()['content-type'], icon).toBe('image/png');
    }

    await page.goto('/');
    // Load-bearing: the cloud serves the manifest behind Access, which needs the cookie.
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('crossorigin', 'use-credentials');
    // The status bar follows the app's own theme, not the OS setting. Other suites leave
    // the saved theme wherever they finished, so set it first.
    const themeColor = page.locator('meta[name="theme-color"]');
    await expect(themeColor).toHaveCount(1);
    await setTheme(page, 'dark');
    await expect(themeColor).toHaveAttribute('content', '#090b0f');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(themeColor).toHaveAttribute('content', '#090b0f');
    await setTheme(page, 'light');
    await expect(themeColor).toHaveAttribute('content', '#f5f7fa');
    await setTheme(page, 'dark');
    await expect(themeColor).toHaveAttribute('content', '#090b0f');
  });
});

test.describe('Phone use', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('Home, Tasks and a task open by tap without horizontal scroll', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    await page.goto('/');
    await expect(page.getByText('Active Tasks')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Open navigation' }).tap();
    await page.getByRole('dialog', { name: 'Navigation' }).getByRole('link', { name: /^Tasks/ }).tap();
    await expect(page).toHaveURL(/\/tasks$/);
    await expect(page.getByText('Every task on this machine')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.locator('a[href="/tasks/TASK-0001"]').first().tap();
    await expect(page).toHaveURL(/\/tasks\/TASK-0001/);
    await expect(page.getByText('Completion report')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole('button', { name: 'New Task' }).tap();
    await expect(page.getByRole('button', { name: 'Start Task' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });
});

test.describe('Long-lived sessions', () => {
  test('a socket that stops answering is replaced as soon as the page comes back', async ({ page }) => {
    let connections = 0;
    let blackhole = false;
    await page.routeWebSocket(/\/ws/, (ws) => {
      connections++;
      const own = connections;
      const server = ws.connectToServer();
      // The first socket goes silent in both directions without closing: a phone that slept.
      ws.onMessage((m) => {
        if (!(blackhole && own === 1)) server.send(m);
      });
      server.onMessage((m) => {
        if (!(blackhole && own === 1)) ws.send(m);
      });
    });
    await page.goto('/');
    await expect(page.getByRole('status').filter({ hasText: 'Orchestrator connected' }).first()).toBeAttached();
    expect(connections).toBe(1);
    blackhole = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    // No pong within the deadline (10 s): a new socket, and the page is live on it.
    await expect.poll(() => connections, { timeout: 20_000 }).toBe(2);
    await expect(page.getByRole('status').filter({ hasText: 'Orchestrator connected' }).first()).toBeAttached();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a page open across a release reloads once for the new build, then says so instead of looping', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Active Tasks')).toBeVisible();
    // The release removed the old build's Tasks chunk.
    let chunkRequests = 0;
    await page.route(/\/assets\/TasksPage-[^/]+\.js$/, (route) => {
      chunkRequests++;
      return route.fulfill({ status: 404, body: 'gone' });
    });
    let loads = 0;
    page.on('load', () => loads++);
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^Tasks/ }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'A new version is available.' })).toBeVisible({ timeout: 20_000 });
    expect(loads).toBe(1);
    expect(chunkRequests).toBeGreaterThanOrEqual(2);
    // The Shell survives: navigation still works.
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^Home/ }).click();
    await expect(page.getByText('Active Tasks')).toBeVisible();
  });
});
