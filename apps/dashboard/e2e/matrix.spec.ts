import { expect, test } from '@playwright/test';
import { PAGES, VIEWPORTS, expectNoAxeViolations, expectNoHorizontalOverflow, setTheme, trackConsoleErrors } from './helpers';

/**
 * design.md §19 visual QA matrix: every core page at the five required
 * viewports, in Dark and Light. Each combination must render, have no
 * page-level horizontal scroll, no console errors and no WCAG 2.2 AA
 * violations (§11, §20). Screenshots are attached to the report for review.
 */
for (const theme of ['dark', 'light'] as const) {
  test.describe(`${theme} theme`, () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeAll(async ({ browser }) => {
      const page = await browser.newPage();
      await page.goto('/');
      await setTheme(page, theme);
      await page.close();
    });

    for (const target of PAGES) {
      test(`${target.name}`, async ({ page }, testInfo) => {
        const errors = trackConsoleErrors(page);
        for (const viewport of VIEWPORTS) {
          await page.setViewportSize({ width: viewport.width, height: viewport.height });
          await page.goto(target.path);
          await expect(page.getByText(target.ready, { exact: false }).first()).toBeVisible();
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
          // Let realtime updates and lazy panels settle before measuring.
          await page.waitForTimeout(300);
          await expectNoHorizontalOverflow(page);
          await testInfo.attach(`${target.name}-${viewport.name}-${theme}.png`, {
            body: await page.screenshot({ fullPage: false }),
            contentType: 'image/png',
          });
          if (viewport.name === 'desktop' || viewport.name === 'mobile') await expectNoAxeViolations(page, testInfo);
        }
        expect(errors, 'console errors').toEqual([]);
      });
    }
  });
}
