import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { AgentInfo } from '@acc/shared';
import { expectNoAxeViolations, expectNoHorizontalOverflow, setTheme, trackConsoleErrors } from './helpers';

/**
 * Settings → Agents & Models: installed CLI versions against agents.compat.json
 * (docs/systems/agents.md#tested-cli-versions), at desktop and phone width in
 * both themes. The demo's simulated agents have no CLI version to judge, so the
 * agent list gets real-looking CLIs on the way to the page: Claude Code newer
 * than any tested version, Codex on its tested one.
 */

const WIDTHS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

async function withInstalledClis(page: Page): Promise<void> {
  await page.route(/\/api\/agents$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const agents = (await response.json()) as AgentInfo[];
    const cli = (a: AgentInfo, version: string, compat: AgentInfo['compat']): AgentInfo => ({
      ...a,
      name: a.id === 'claude' ? 'Claude Code' : 'Codex',
      detection: { found: true, executablePath: `C:\\Users\\operator\\AppData\\Roaming\\npm\\${a.id}.cmd`, version, error: null },
      compat,
    });
    const json = agents.map((a) =>
      a.id === 'claude'
        ? cli(a, '2.1.290', { tested: { min: '2.1.280', max: '2.1.283' }, status: 'unverified' })
        : a.id === 'codex'
          ? cli(a, '0.156.1', { tested: { min: '0.156.1', max: '0.156.1' }, status: 'tested' })
          : a,
    );
    await route.fulfill({ response, json });
  });
}

async function check(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await expectNoHorizontalOverflow(page);
  await testInfo.attach(`${name}.png`, { body: await page.screenshot({ fullPage: false }), contentType: 'image/png' });
  await expectNoAxeViolations(page, testInfo);
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`installed agent versions in the ${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto('/');
      await setTheme(page, theme);
    });

    test('a CLI version outside the tested range is marked unverified; a tested one is not', async ({ page }, testInfo) => {
      const errors = trackConsoleErrors(page);
      await withInstalledClis(page);
      for (const size of WIDTHS) {
        await page.setViewportSize({ width: size.width, height: size.height });
        await page.goto('/settings/agents');
        const versions = page.getByRole('region', { name: 'Installed versions' });
        await expect(versions).toBeVisible();
        const claude = versions.getByRole('listitem').filter({ hasText: 'Claude Code' });
        await expect(claude).toContainText('v2.1.290');
        await expect(claude.getByText('Unverified', { exact: true })).toBeVisible();
        await expect(claude).toContainText('Tested with versions 2.1.280 to 2.1.283.');
        const codex = versions.getByRole('listitem').filter({ hasText: 'Codex' });
        await expect(codex).toContainText('v0.156.1');
        await expect(codex.getByText('Tested', { exact: true })).toBeVisible();
        await expect(codex.getByText('Unverified', { exact: true })).toHaveCount(0);
        await check(page, testInfo, `agent-versions-${size.name}-${theme}`);
      }
      expect(errors).toEqual([]);
    });
  });
}
