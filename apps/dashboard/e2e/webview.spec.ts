import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations, expectNoHorizontalOverflow, trackConsoleErrors } from './helpers';

const dist = path.resolve(import.meta.dirname, '..', 'dist', 'webview');

/** A representative subset of VS Code's Dark Modern theme variables. */
const VSCODE_DARK = `
  --vscode-font-family: "Segoe WPC", "Segoe UI", sans-serif;
  --vscode-editor-font-family: Consolas, "Courier New", monospace;
  --vscode-editor-background: #1f1f1f;
  --vscode-sideBar-background: #181818;
  --vscode-editorWidget-background: #202020;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-panel-border: #2b2b2b;
  --vscode-input-border: #3c3c3c;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-disabledForeground: #8b8b8b;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-focusBorder: #0078d4;
  --vscode-testing-iconPassed: #73c991;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-errorForeground: #f85149;
  --vscode-editorInfo-foreground: #3794ff;
`;

/**
 * Serves a page shaped exactly like the extension's WebView HTML
 * (apps/vscode-extension/src/webview.ts) from the orchestrator's origin, so
 * the bundle talks to the real API exactly as it does inside VS Code.
 */
async function openWebview(page: Page, baseURL: string, initialPath = '/') {
  const token = await page.request.get('/').then(async (r) => /name="acc-token" content="([^"]+)"/.exec(await r.text())![1]!);
  const baseUrl = new URL(baseURL).origin;
  await page.route('**/__webview/**', async (route) => {
    const url = new URL(route.request().url());
    const file = url.pathname.replace('/__webview/', '');
    if (file === 'index.html') {
      const boot = JSON.stringify({ baseUrl, token, initialPath });
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="en" data-theme="vscode"><head><meta charset="UTF-8">
<style>:root{${VSCODE_DARK}}</style><link rel="stylesheet" href="/__webview/webview.css"></head>
<body><div id="root"></div>
<script>window.__posted=[];window.acquireVsCodeApi=()=>({postMessage:(m)=>window.__posted.push(m),getState:()=>null,setState:()=>{}});window.__ACC_WEBVIEW__=${boot};</script>
<script type="module" src="/__webview/webview.js"></script></body></html>`,
      });
    }
    return route.fulfill({ body: readFileSync(path.join(dist, file)), contentType: file.endsWith('.css') ? 'text/css' : 'text/javascript' });
  });
  await page.goto('/__webview/index.html');
}

// The harness document is synthesized by page.route, so Chrome cannot tell it
// came from loopback and applies Local Network Access checks to its
// WebSocket. The real WebView is not served this way; lift the check here only.
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } });

test.describe('VS Code WebView (design.md §13)', () => {
  test('renders with the editor theme in a narrow sidebar and a panel', async ({ page, baseURL }, testInfo) => {
    const errors = trackConsoleErrors(page);
    for (const width of [320, 480, 900]) {
      await page.setViewportSize({ width, height: 800 });
      await openWebview(page, baseURL!);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'vscode');
      await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      // Tokens resolve to the editor theme, not the standalone palette.
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).toBe('rgb(31, 31, 31)');
      await testInfo.attach(`webview-${width}.png`, { body: await page.screenshot(), contentType: 'image/png' });
    }
    await expectNoAxeViolations(page, testInfo);
    expect(errors).toEqual([]);
  });

  test('core task actions stay available and diffs open in the editor', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await openWebview(page, baseURL!, '/tasks/TASK-0001?tab=changes');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Open file' }).click();
    await page.getByRole('button', { name: 'Open diff in editor' }).click();
    const posted = await page.evaluate(() => (window as unknown as { __posted: Array<{ type: string }> }).__posted);
    expect(posted).toContainEqual(expect.objectContaining({ type: 'openDiff', taskId: 'TASK-0001' }));
    expect(posted).toContainEqual(expect.objectContaining({ type: 'openFile', path: 'sim-output.md' }));
    // Details drawer carries the inspector controls in narrow panels.
    await page.getByRole('button', { name: 'Details' }).click();
    await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible();
  });
});
