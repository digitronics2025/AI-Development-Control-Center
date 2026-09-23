import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { redact } from '@acc/security';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { z } from 'zod';
import { resolveInside } from '../paths.js';
import { missing, operation, type OperationContext, type OperationResult, type ToolDetection, type ToolProvider } from '../sdk.js';

/**
 * Browser automation with Playwright (V2 plan §20–21). Deterministic checks
 * the orchestrator can trust as evidence: what the page logged, which
 * requests failed, what it looked like at desktop and phone widths.
 */

const require = createRequire(import.meta.url);

export const VIEWPORTS = {
  desktop: { width: 1280, height: 800, isMobile: false },
  phone: { width: 390, height: 844, isMobile: true },
  tablet: { width: 768, height: 1024, isMobile: true },
} as const;
type ViewportName = keyof typeof VIEWPORTS;

function chromeCandidates(): string[] {
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
    return roots.flatMap((r) => [path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]);
  }
  if (process.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
}

interface BrowserChoice {
  executablePath: string | null;
  label: string;
}

/** Playwright's own Chromium for this version when installed, else an installed Chrome or Edge. */
export async function findBrowser(): Promise<BrowserChoice | null> {
  try {
    const { chromium } = await import('playwright-core');
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return { executablePath: bundled, label: 'Playwright Chromium' };
  } catch {
    /* playwright-core missing */
  }
  const system = chromeCandidates().find((c) => existsSync(c));
  return system ? { executablePath: system, label: /msedge/i.test(system) ? 'Microsoft Edge' : 'Google Chrome' } : null;
}

async function launch(): Promise<Browser> {
  const choice = await findBrowser();
  if (!choice) throw new Error('No browser available: run `npx playwright install chromium`');
  const { chromium } = await import('playwright-core');
  return chromium.launch({ headless: true, executablePath: choice.executablePath ?? undefined, args: ['--no-first-run', '--no-default-browser-check'] });
}

const httpUrl = z
  .string()
  .url()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs');

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

interface PageObservation {
  viewport: ViewportName;
  url: string;
  status: number | null;
  title: string;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: Array<{ url: string; status: number | null; failure: string | null }>;
  timing: { domContentLoadedMs: number | null; loadMs: number | null };
  horizontalOverflow: boolean;
  screenshot: { id: string; name: string } | null;
}

function observe(page: Page, origin: string, sameOriginOnly: boolean) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: PageObservation['failedRequests'] = [];
  const relevant = (url: string) => !sameOriginOnly || url.startsWith(origin);
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(redact(msg.text()).slice(0, 500));
  });
  page.on('pageerror', (err) => pageErrors.push(redact(err.message).slice(0, 500)));
  page.on('requestfailed', (req) => {
    const reason = req.failure()?.errorText ?? 'failed';
    // Navigations the page aborted itself (e.g. prefetch cancelled) are not failures.
    if (relevant(req.url()) && !/ERR_ABORTED/.test(reason)) failedRequests.push({ url: redact(req.url()), status: null, failure: reason });
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && relevant(res.url())) failedRequests.push({ url: redact(res.url()), status: res.status(), failure: null });
  });
  return { consoleErrors, pageErrors, failedRequests };
}

async function saveScreenshot(ctx: OperationContext, page: Page, name: string): Promise<{ id: string; name: string } | null> {
  const png = await page.screenshot({ fullPage: false, type: 'png' });
  if (ctx.artifacts) return ctx.artifacts.write({ name, type: 'screenshot', content: png, mime: 'image/png' });
  const dir = path.join(ctx.tempDir, 'screenshots');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, png);
  return { id: file, name };
}

async function checkAt(ctx: OperationContext, browser: Browser, input: { url: string; waitUntil: 'load' | 'domcontentloaded' | 'networkidle'; settleMs: number; sameOriginOnly: boolean; screenshot: boolean; timeoutSec: number }, viewport: ViewportName): Promise<PageObservation> {
  const vp = VIEWPORTS[viewport];
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.isMobile, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    const origin = new URL(input.url).origin;
    const seen = observe(page, origin, input.sameOriginOnly);
    let status: number | null = null;
    try {
      const response = await page.goto(input.url, { waitUntil: input.waitUntil, timeout: input.timeoutSec * 1000 });
      status = response?.status() ?? null;
    } catch (error) {
      seen.pageErrors.push(`Navigation failed: ${redact((error as Error).message).split('\n')[0]}`);
    }
    if (input.settleMs) await page.waitForTimeout(input.settleMs);
    const timing = await page
      .evaluate(() => {
        // Runs in the page: browser globals are reached through globalThis (this package compiles without DOM types).
        const nav = (globalThis as any).performance.getEntriesByType('navigation')[0] as { domContentLoadedEventEnd: number; loadEventEnd: number } | undefined;
        return { domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null, loadMs: nav ? Math.round(nav.loadEventEnd) : null };
      })
      .catch(() => ({ domContentLoadedMs: null, loadMs: null }));
    const horizontalOverflow = await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth > (globalThis as any).innerWidth + 1).catch(() => false);
    const title = await page.title().catch(() => '');
    const safeName = new URL(input.url).pathname.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'root';
    const screenshot = input.screenshot ? await saveScreenshot(ctx, page, `${safeName}-${viewport}.png`).catch(() => null) : null;
    return { viewport, url: input.url, status, title: redact(title), ...seen, timing, horizontalOverflow, screenshot };
  } finally {
    await context.close();
  }
}

export interface CheckPageInput {
  url: string;
  viewports: ViewportName[];
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle';
  settleMs: number;
  sameOriginOnly: boolean;
  screenshot: boolean;
  timeoutSec: number;
}

/** Open a page at each viewport and report everything that went wrong (V2 plan §21). */
export async function checkPage(ctx: OperationContext, input: CheckPageInput): Promise<OperationResult> {
  return withBrowser(async (browser) => {
    const pages: PageObservation[] = [];
    for (const viewport of input.viewports) pages.push(await checkAt(ctx, browser, input, viewport));
    const problems = pages.flatMap((p) => [
      ...(p.status !== null && p.status >= 400 ? [`${p.viewport}: HTTP ${p.status}`] : []),
      ...(p.status === null && p.pageErrors.length === 0 ? [`${p.viewport}: no response`] : []),
      ...p.pageErrors.map((e) => `${p.viewport}: page error: ${e}`),
      ...p.consoleErrors.map((e) => `${p.viewport}: console error: ${e}`),
      ...p.failedRequests.map((r) => `${p.viewport}: request failed: ${r.url} ${r.status ?? r.failure}`),
      ...(p.horizontalOverflow ? [`${p.viewport}: page scrolls horizontally`] : []),
    ]);
    const evidence = pages.map((p) => `${p.viewport} ${p.url} → ${p.status ?? 'no response'} · ${p.consoleErrors.length} console error(s) · ${p.pageErrors.length} page error(s) · ${p.failedRequests.length} failed request(s)${p.horizontalOverflow ? ' · horizontal overflow' : ''}`);
    return {
      ok: problems.length === 0,
      summary: problems.length ? `${problems.length} problem(s) on ${input.url}: ${problems[0]}` : `${input.url} loads cleanly at ${input.viewports.join(' and ')} widths`,
      output: { pages, problems },
      evidence,
      artifacts: pages.flatMap((p) => (p.screenshot ? [p.screenshot] : [])),
      networkTargets: [new URL(input.url).host],
      ...(problems.length ? { error: { code: 'FAILED' as const, message: problems.slice(0, 5).join('; ') } } : {}),
    };
  });
}

const flowStep = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), url: httpUrl }),
  z.object({ action: z.literal('click'), selector: z.string().min(1).max(500) }),
  z.object({ action: z.literal('fill'), selector: z.string().min(1).max(500), value: z.string().max(10_000) }),
  z.object({ action: z.literal('press'), key: z.string().min(1).max(50), selector: z.string().max(500).optional() }),
  z.object({ action: z.literal('select'), selector: z.string().min(1).max(500), value: z.string().max(500) }),
  z.object({ action: z.literal('check'), selector: z.string().min(1).max(500) }),
  z.object({ action: z.literal('upload'), selector: z.string().min(1).max(500), file: z.string().min(1).max(1000) }),
  z.object({ action: z.literal('wait_for'), selector: z.string().max(500).optional(), text: z.string().max(500).optional(), timeoutSec: z.number().int().min(1).max(120).default(15) }),
  z.object({ action: z.literal('expect_text'), text: z.string().min(1).max(1000), selector: z.string().max(500).optional() }),
  z.object({ action: z.literal('expect_url'), contains: z.string().min(1).max(1000) }),
  z.object({ action: z.literal('set_viewport'), viewport: z.enum(['desktop', 'phone', 'tablet']) }),
  z.object({ action: z.literal('screenshot'), name: z.string().min(1).max(60).regex(/^[\w-]+$/) }),
  z.object({ action: z.literal('download'), selector: z.string().min(1).max(500) }),
]);
type FlowStep = z.infer<typeof flowStep>;

async function runStep(ctx: OperationContext, page: Page, step: FlowStep, log: string[], artifacts: Array<{ id: string; name: string }>): Promise<void> {
  switch (step.action) {
    case 'goto':
      await page.goto(step.url, { waitUntil: 'load' });
      log.push(`goto ${step.url}`);
      return;
    case 'click':
      await page.locator(step.selector).first().click({ timeout: 15_000 });
      log.push(`click ${step.selector}`);
      return;
    case 'fill':
      await page.locator(step.selector).first().fill(step.value, { timeout: 15_000 });
      log.push(`fill ${step.selector}`);
      return;
    case 'press':
      if (step.selector) await page.locator(step.selector).first().press(step.key);
      else await page.keyboard.press(step.key);
      log.push(`press ${step.key}`);
      return;
    case 'select':
      await page.locator(step.selector).first().selectOption(step.value);
      log.push(`select ${step.value} in ${step.selector}`);
      return;
    case 'check':
      await page.locator(step.selector).first().check();
      log.push(`check ${step.selector}`);
      return;
    case 'upload': {
      const file = resolveInside(ctx.roots, ctx.cwd, step.file);
      await page.locator(step.selector).first().setInputFiles(file);
      log.push(`upload ${step.file}`);
      return;
    }
    case 'wait_for':
      if (step.selector) await page.locator(step.selector).first().waitFor({ timeout: step.timeoutSec * 1000 });
      else if (step.text) await page.getByText(step.text).first().waitFor({ timeout: step.timeoutSec * 1000 });
      else await page.waitForLoadState('networkidle', { timeout: step.timeoutSec * 1000 });
      log.push(`waited for ${step.selector ?? step.text ?? 'network idle'}`);
      return;
    case 'expect_text': {
      const scope = step.selector ? page.locator(step.selector).first() : page.locator('body');
      const text = (await scope.innerText({ timeout: 10_000 })) ?? '';
      if (!text.includes(step.text)) throw new Error(`Expected text not found: "${step.text}"`);
      log.push(`saw "${step.text}"`);
      return;
    }
    case 'expect_url':
      if (!page.url().includes(step.contains)) throw new Error(`Expected URL to contain "${step.contains}", got ${page.url()}`);
      log.push(`url contains ${step.contains}`);
      return;
    case 'set_viewport': {
      const vp = VIEWPORTS[step.viewport];
      await page.setViewportSize({ width: vp.width, height: vp.height });
      log.push(`viewport ${step.viewport}`);
      return;
    }
    case 'screenshot': {
      const shot = await saveScreenshot(ctx, page, `${step.name}.png`);
      if (shot) artifacts.push(shot);
      log.push(`screenshot ${step.name}`);
      return;
    }
    case 'download': {
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.locator(step.selector).first().click()]);
      const target = path.join(ctx.tempDir, 'downloads', download.suggestedFilename().replace(/[^\w.-]+/g, '_'));
      mkdirSync(path.dirname(target), { recursive: true });
      await download.saveAs(target);
      log.push(`downloaded ${download.suggestedFilename()}`);
      return;
    }
  }
}

const sessionName = z.string().min(1).max(60).regex(/^[\w-]+$/);

function sessionFile(ctx: OperationContext, name: string): string {
  return path.join(ctx.stateDir, 'browser-sessions', `${name}.json`);
}

async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await launch();
  try {
    return await fn(browser);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

export function browserProvider(): ToolProvider {
  return {
    id: 'playwright',
    name: 'Playwright',
    description: 'Headless Chromium for page checks, flows, screenshots and accessibility scans.',
    category: 'browser',
    async detect(): Promise<ToolDetection> {
      let version: string | null;
      try {
        version = JSON.parse(readFileSync(require.resolve('playwright-core/package.json'), 'utf8')).version;
      } catch {
        return missing('playwright-core is not installed with the Control Center');
      }
      const browser = await findBrowser();
      if (!browser) return { ...missing('No browser: run `npx playwright install chromium`'), version };
      return { installed: true, version, path: browser.executablePath, auth: { required: false, state: 'not_required', message: null }, message: browser.label };
    },
    operations: [
      operation({
        id: 'browser.check_page',
        title: 'Check a page in a real browser',
        description: 'Open a URL at desktop and phone widths; report HTTP status, console errors, page errors, failed requests, horizontal overflow and screenshots. Use it to verify a web change actually works.',
        input: z.object({
          url: httpUrl,
          viewports: z.array(z.enum(['desktop', 'phone', 'tablet'])).min(1).max(3).default(['desktop', 'phone']),
          waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load'),
          settleMs: z.number().int().min(0).max(10_000).default(800),
          sameOriginOnly: z.boolean().default(true),
          screenshot: z.boolean().default(true),
          timeoutSec: z.number().int().min(5).max(120).default(30),
        }),
        level: 1,
        classify: (input) => ({ effects: isLoopback(input.url) ? [] : ['network'] }),
        run: (input, ctx) => checkPage(ctx, input),
      }),
      operation({
        id: 'browser.screenshot',
        title: 'Screenshot a page',
        description: 'Capture a page at a viewport.',
        input: z.object({ url: httpUrl, viewport: z.enum(['desktop', 'phone', 'tablet']).default('desktop'), timeoutSec: z.number().int().min(5).max(120).default(30) }),
        level: 1,
        async run(input, ctx) {
          return withBrowser(async (browser) => {
            const o = await checkAt(ctx, browser, { url: input.url, waitUntil: 'load', settleMs: 500, sameOriginOnly: true, screenshot: true, timeoutSec: input.timeoutSec }, input.viewport);
            return { ok: Boolean(o.screenshot), summary: o.screenshot ? `Saved ${o.screenshot.name}` : 'Screenshot failed', artifacts: o.screenshot ? [o.screenshot] : [], output: { status: o.status, title: o.title } };
          });
        },
      }),
      operation({
        id: 'browser.run_flow',
        title: 'Run a browser flow',
        description:
          'Drive a page through steps (goto, click, fill, press, select, check, upload, wait_for, expect_text, expect_url, set_viewport, screenshot, download) and report console/page errors. `session` reuses or saves a signed-in state kept outside the repository.',
        input: z.object({
          url: httpUrl,
          steps: z.array(flowStep).min(1).max(60),
          viewport: z.enum(['desktop', 'phone', 'tablet']).default('desktop'),
          session: sessionName.optional(),
          saveSession: z.boolean().default(false),
          timeoutSec: z.number().int().min(5).max(600).default(120),
        }),
        level: 2,
        classify: () => ({ reasons: ['Interacts with a page (may submit forms)'], effects: ['network'] }),
        async run(input, ctx) {
          return withBrowser(async (browser) => {
            const vp = VIEWPORTS[input.viewport];
            const stateFile = input.session ? sessionFile(ctx, input.session) : null;
            const context: BrowserContext = await browser.newContext({
              viewport: { width: vp.width, height: vp.height },
              isMobile: vp.isMobile,
              acceptDownloads: true,
              ...(stateFile && existsSync(stateFile) ? { storageState: stateFile } : {}),
            });
            context.setDefaultTimeout(Math.min(30_000, input.timeoutSec * 1000));
            const log: string[] = [];
            const artifacts: Array<{ id: string; name: string }> = [];
            try {
              const page = await context.newPage();
              const seen = observe(page, new URL(input.url).origin, true);
              await page.goto(input.url, { waitUntil: 'load', timeout: input.timeoutSec * 1000 });
              let failedAt: string | null = null;
              for (const [i, step] of input.steps.entries()) {
                try {
                  await runStep(ctx, page, step, log, artifacts);
                } catch (error) {
                  failedAt = `step ${i + 1} (${step.action}): ${redact((error as Error).message).split('\n')[0]}`;
                  artifacts.push(...[await saveScreenshot(ctx, page, `flow-failure-step-${i + 1}.png`).catch(() => null)].filter((a): a is { id: string; name: string } => a !== null));
                  break;
                }
              }
              if (stateFile && input.saveSession && !failedAt) {
                mkdirSync(path.dirname(stateFile), { recursive: true });
                await context.storageState({ path: stateFile });
                log.push(`session "${input.session}" saved`);
              }
              const problems = [...seen.pageErrors.map((e) => `page error: ${e}`), ...seen.consoleErrors.map((e) => `console error: ${e}`)];
              const ok = !failedAt && seen.pageErrors.length === 0;
              return {
                ok,
                summary: failedAt ? `Flow failed at ${failedAt}` : `Flow passed: ${input.steps.length} step(s)${problems.length ? ` · ${problems.length} console problem(s)` : ''}`,
                output: { steps: log, problems, failedRequests: seen.failedRequests, finalUrl: redact(page.url()) },
                evidence: [`flow on ${input.url}: ${log.length}/${input.steps.length} steps${failedAt ? ` · failed at ${failedAt}` : ' passed'}`],
                artifacts,
                ...(ok ? {} : { error: { code: 'FAILED' as const, message: failedAt ?? problems[0] ?? 'Page error' } }),
              };
            } finally {
              await context.close();
            }
          });
        },
      }),
      operation({
        id: 'browser.accessibility',
        title: 'Accessibility scan',
        description: 'Run axe-core (WCAG 2.2 AA rules) on a page and list violations.',
        input: z.object({ url: httpUrl, viewport: z.enum(['desktop', 'phone', 'tablet']).default('desktop') }),
        level: 1,
        async run(input) {
          const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
          return withBrowser(async (browser) => {
            const vp = VIEWPORTS[input.viewport];
            const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
            try {
              const page = await context.newPage();
              await page.goto(input.url, { waitUntil: 'load', timeout: 30_000 });
              await page.addScriptTag({ content: axeSource });
              const result = (await page.evaluate(async () => {
                const axe = (globalThis as any).axe;
                const r = await axe.run((globalThis as any).document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
                return r.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length }));
              })) as Array<{ id: string; impact: string; help: string; nodes: number }>;
              return {
                ok: result.length === 0,
                summary: result.length ? `${result.length} accessibility violation(s): ${result.map((v) => v.id).slice(0, 5).join(', ')}` : 'No WCAG A/AA violations found',
                output: { violations: result },
                evidence: [`axe on ${input.url}: ${result.length} violation(s)`],
                ...(result.length ? { error: { code: 'FAILED' as const, message: `${result.length} violation(s)` } } : {}),
              };
            } finally {
              await context.close();
            }
          });
        },
      }),
      operation({
        id: 'browser.storage',
        title: 'Inspect cookies and storage',
        description: 'Cookie names and localStorage/sessionStorage keys a page sets (values are never shown).',
        input: z.object({ url: httpUrl, session: sessionName.optional() }),
        level: 1,
        async run(input, ctx) {
          return withBrowser(async (browser) => {
            const stateFile = input.session ? sessionFile(ctx, input.session) : null;
            const context = await browser.newContext(stateFile && existsSync(stateFile) ? { storageState: stateFile } : {});
            try {
              const page = await context.newPage();
              await page.goto(input.url, { waitUntil: 'load', timeout: 30_000 });
              const cookies = (await context.cookies()).map((c) => ({ name: c.name, domain: c.domain, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite }));
              const storage = await page.evaluate(() => ({ local: Object.keys((globalThis as any).localStorage), session: Object.keys((globalThis as any).sessionStorage) }));
              return { ok: true, summary: `${cookies.length} cookie(s), ${storage.local.length} localStorage key(s)`, output: { cookies, storage } };
            } finally {
              await context.close();
            }
          });
        },
      }),
    ],
  };
}

