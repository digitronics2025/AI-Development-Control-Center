import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { credentialFreeEnv, redact } from '@acc/security';
import { BROWSER_VIEWPORTS } from '@acc/shared';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { z } from 'zod';
import { guardBrowserContext } from '../net-guard.js';
import { resolveInside } from '../paths.js';
import { missing, operation, type OperationContext, type OperationResult, type ResultImage, type ToolDetection, type ToolOperation, type ToolProvider } from '../sdk.js';

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
  /** A large laptop or monitor (docs/systems/design-agent.md). */
  wide: { width: 1440, height: 900, isMobile: false },
  /** A small laptop: where desktop layouts first break. */
  'narrow-desktop': { width: 1024, height: 768, isMobile: false },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;
export const VIEWPORT_NAMES = BROWSER_VIEWPORTS satisfies readonly ViewportName[];
export const viewportField = z.enum(VIEWPORT_NAMES);

/**
 * How the page is shown (docs/systems/design-agent.md): a colour scheme and
 * reduced motion as the operating system would ask for them, and a pixel
 * density. Omitted fields keep the browser's defaults (light, motion, 1×).
 */
export const displayFields = {
  colorScheme: z.enum(['light', 'dark', 'no-preference']).optional().describe('prefers-color-scheme the page sees.'),
  reducedMotion: z.enum(['reduce', 'no-preference']).optional().describe('prefers-reduced-motion the page sees.'),
  deviceScaleFactor: z.number().min(1).max(3).optional().describe('Pixel density (2 = a retina screen); larger pictures.'),
};
export interface DisplayOptions {
  colorScheme?: 'light' | 'dark' | 'no-preference';
  reducedMotion?: 'reduce' | 'no-preference';
  deviceScaleFactor?: number;
}

/** Browser context options for a viewport and display: what every tool opening a page uses. */
export function contextOptions(viewport: ViewportName, display: DisplayOptions = {}) {
  const vp = VIEWPORTS[viewport];
  return {
    viewport: { width: vp.width, height: vp.height },
    isMobile: vp.isMobile,
    hasTouch: vp.isMobile,
    deviceScaleFactor: display.deviceScaleFactor ?? 1,
    ...(display.colorScheme ? { colorScheme: display.colorScheme } : {}),
    ...(display.reducedMotion ? { reducedMotion: display.reducedMotion } : {}),
  };
}

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

export async function launch(options: { headless?: boolean } = {}): Promise<Browser> {
  const choice = await findBrowser();
  if (!choice) throw new Error('No browser available: run `npx playwright install chromium`');
  const { chromium } = await import('playwright-core');
  // The browser never needs a credential from the orchestrator's environment (audit F-03).
  return chromium.launch({ headless: options.headless ?? true, executablePath: choice.executablePath ?? undefined, args: ['--no-first-run', '--no-default-browser-check'], env: credentialFreeEnv(process.env) as Record<string, string> });
}

export const httpUrl = z
  .string()
  .url()
  .max(2000)
  .refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs');

export function isLoopback(url: string): boolean {
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

export function observe(page: Page, origin: string, sameOriginOnly: boolean) {
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

/** Largest picture handed to a model; bigger ones are still saved, just not shown. */
const MAX_MODEL_IMAGE_BYTES = 3 * 1024 * 1024;

export interface Capture {
  /** Where the file was kept: a task artifact, or a scratch file outside a task. */
  saved: { id: string; name: string } | null;
  /** The same picture for the model, or null when it is too large to send. */
  image: ResultImage | null;
}

export async function captureScreenshot(ctx: OperationContext, page: Page, name: string, fullPage = false): Promise<Capture> {
  const png = await page.screenshot({ fullPage, type: 'png' });
  const image: ResultImage | null = png.length <= MAX_MODEL_IMAGE_BYTES ? { name, mime: 'image/png', data: png } : null;
  if (ctx.artifacts) return { saved: await ctx.artifacts.write({ name, type: 'screenshot', content: png, mime: 'image/png' }), image };
  const dir = path.join(ctx.tempDir, 'screenshots');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, png);
  return { saved: { id: file, name }, image };
}

async function saveScreenshot(ctx: OperationContext, page: Page, name: string, images?: ResultImage[]): Promise<{ id: string; name: string } | null> {
  const shot = await captureScreenshot(ctx, page, name);
  if (images && shot.image) images.push(shot.image);
  return shot.saved;
}

async function checkAt(ctx: OperationContext, browser: Browser, input: { url: string; waitUntil: 'load' | 'domcontentloaded' | 'networkidle'; settleMs: number; sameOriginOnly: boolean; screenshot: boolean; timeoutSec: number } & DisplayOptions, viewport: ViewportName, images?: ResultImage[]): Promise<PageObservation> {
  const context = await browser.newContext(contextOptions(viewport, input));
  await guardBrowserContext(context);
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
    // Against clientWidth, not innerWidth: with mobile emulation innerWidth grows to the content's width, so a page
    // wider than the phone never looked like it overflowed.
    const horizontalOverflow = await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth > (globalThis as any).document.documentElement.clientWidth + 1).catch(() => false);
    const title = await page.title().catch(() => '');
    const safeName = new URL(input.url).pathname.replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'root';
    const scheme = input.colorScheme && input.colorScheme !== 'no-preference' ? `-${input.colorScheme}` : '';
    const screenshot = input.screenshot ? await saveScreenshot(ctx, page, `${safeName}-${viewport}${scheme}.png`, images).catch(() => null) : null;
    return { viewport, url: input.url, status, title: redact(title), ...seen, timing, horizontalOverflow, screenshot };
  } finally {
    await context.close();
  }
}

export interface CheckPageInput extends DisplayOptions {
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
    const images: ResultImage[] = [];
    for (const viewport of input.viewports) pages.push(await checkAt(ctx, browser, input, viewport, images));
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
      ...(images.length ? { images } : {}),
      ...(problems.length ? { error: { code: 'FAILED' as const, message: problems.slice(0, 5).join('; ') } } : {}),
    };
  });
}

interface MatrixInput {
  url: string;
  viewports: ViewportName[];
  colorSchemes: Array<'light' | 'dark'>;
  reducedMotion?: 'reduce' | 'no-preference';
  settleMs: number;
  timeoutSec: number;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * One contact sheet: the captures side by side at a common height, each with
 * its label, drawn by Chromium from `data:` URLs with scripts off and every
 * request refused. JPEG under the model ceiling.
 */
async function contactSheet(browser: Browser, title: string, cells: Array<{ label: string; png: Buffer | null }>): Promise<Buffer | null> {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1600, height: 700 }, deviceScaleFactor: 1 });
  await guardBrowserContext(context);
  await context.route('**/*', (route) => route.abort('blockedbyclient'));
  try {
    const page = await context.newPage();
    const figures = cells
      .map((c) => `<figure style="margin:0;display:flex;flex-direction:column;gap:6px"><figcaption style="font:600 15px system-ui,sans-serif;color:#111">${escapeHtml(c.label)}</figcaption>${c.png ? `<img alt="" src="data:image/png;base64,${c.png.toString('base64')}" style="height:520px;width:auto;border:1px solid #999">` : '<div style="height:520px;width:240px;display:grid;place-items:center;border:1px dashed #999;font:14px system-ui;color:#333">not captured</div>'}</figure>`)
      .join('');
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#e6e6e6"><main id="sheet" style="display:inline-flex;flex-direction:column;gap:10px;padding:16px"><h1 style="margin:0;font:700 18px system-ui,sans-serif;color:#111">${escapeHtml(title)}</h1><div style="display:flex;gap:16px;align-items:flex-start">${figures}</div></main></body></html>`, { waitUntil: 'load', timeout: 20_000 });
    const sheet = page.locator('#sheet');
    for (const quality of [80, 65, 50]) {
      const data = await sheet.screenshot({ type: 'jpeg', quality, timeout: 20_000 });
      if (data.length <= MAX_MODEL_IMAGE_BYTES) return data;
    }
    return null;
  } finally {
    await context.close();
  }
}

/** A page at every width in each colour scheme, as contact sheets for the model (docs/systems/design-agent.md). */
export async function visualMatrix(ctx: OperationContext, input: MatrixInput): Promise<OperationResult> {
  const order = [...input.viewports].sort((a, b) => VIEWPORTS[a].width - VIEWPORTS[b].width);
  return withBrowser(async (browser) => {
    const cells: Array<PageObservation & { colorScheme: 'light' | 'dark' }> = [];
    const images: ResultImage[] = [];
    for (const scheme of input.colorSchemes) {
      const captures: ResultImage[] = [];
      const row: Array<{ label: string; png: Buffer | null }> = [];
      for (const viewport of order) {
        const before = captures.length;
        const o = await checkAt(ctx, browser, { url: input.url, waitUntil: 'load', settleMs: input.settleMs, sameOriginOnly: true, screenshot: true, timeoutSec: input.timeoutSec, colorScheme: scheme, reducedMotion: input.reducedMotion }, viewport, captures);
        cells.push({ ...o, colorScheme: scheme });
        const vp = VIEWPORTS[viewport];
        row.push({ label: `${viewport} ${vp.width}×${vp.height}${o.horizontalOverflow ? ' · overflows' : ''}`, png: captures.length > before ? captures.at(-1)!.data : null });
      }
      const sheet = await contactSheet(browser, `${input.url} · ${scheme}`, row);
      if (sheet) images.push({ name: `matrix-${scheme}.jpg`, mime: 'image/jpeg', data: sheet });
    }
    const problems = cells.flatMap((c) => {
      const at = `${c.viewport} ${c.colorScheme}`;
      return [
        ...(c.status !== null && c.status >= 400 ? [`${at}: HTTP ${c.status}`] : []),
        ...c.pageErrors.map((e) => `${at}: page error: ${e}`),
        ...c.consoleErrors.map((e) => `${at}: console error: ${e}`),
        ...(c.horizontalOverflow ? [`${at}: page scrolls horizontally`] : []),
      ];
    });
    return {
      ok: problems.length === 0,
      summary: problems.length ? `${problems.length} problem(s) across ${cells.length} views of ${input.url}: ${problems[0]}` : `${input.url} at ${order.join(', ')} in ${input.colorSchemes.join(' and ')}: no loading problems`,
      output: { cells: cells.map((c) => ({ viewport: c.viewport, colorScheme: c.colorScheme, status: c.status, consoleErrors: c.consoleErrors, pageErrors: c.pageErrors, horizontalOverflow: c.horizontalOverflow, screenshot: c.screenshot })), problems },
      evidence: [`visual matrix of ${input.url}: ${order.length} widths × ${input.colorSchemes.length} schemes, ${problems.length} problem(s)`],
      artifacts: cells.flatMap((c) => (c.screenshot ? [c.screenshot] : [])),
      networkTargets: [new URL(input.url).host],
      ...(images.length ? { images } : {}),
      ...(problems.length ? { error: { code: 'FAILED' as const, message: problems.slice(0, 5).join('; ') } } : {}),
    };
  });
}

/** The most HTML one style tile takes (inline styles and `data:` pictures included). */
export const MAX_TILE_HTML = 1_000_000;
/** Taller tiles are cut here: a style tile is a board, not a whole site. */
const MAX_TILE_HEIGHT = 4000;

/**
 * A Chromium that cannot reach anything: every connection goes to a closed
 * port through a proxy that loopback does not bypass, so even what request
 * routing never sees (a preconnect, a prefetch) goes nowhere.
 */
async function launchSealed(): Promise<Browser> {
  const choice = await findBrowser();
  if (!choice) throw new Error('No browser available: run `npx playwright install chromium` (or install Chrome/Edge)');
  const { chromium } = await import('playwright-core');
  return chromium.launch({
    headless: true,
    executablePath: choice.executablePath ?? undefined,
    args: ['--no-first-run', '--no-default-browser-check', '--dns-prefetch-disable'],
    proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
    env: credentialFreeEnv(process.env) as Record<string, string>,
  });
}

export interface RenderHtmlInput {
  html: string;
  name: string;
  viewport: ViewportName;
  colorSchemes: Array<'light' | 'dark'>;
  timeoutSec: number;
}

/**
 * A style tile or any self-contained HTML drawn for the model
 * (docs/systems/design-agent.md): scripts off, service workers blocked, every
 * request refused and named (only `data:` URLs load), at one width in each
 * colour scheme. Nothing is fetched and nothing in the repository changes.
 */
export async function renderHtml(ctx: OperationContext, input: RenderHtmlInput): Promise<OperationResult> {
  const browser = await launchSealed();
  try {
    const blocked = new Map<string, string>();
    const tiles: Array<{ colorScheme: 'light' | 'dark'; width: number; height: number; clipped: boolean; screenshot: { id: string; name: string } | null }> = [];
    const images: ResultImage[] = [];
    for (const scheme of input.colorSchemes) {
      const context = await browser.newContext({ ...contextOptions(input.viewport, { colorScheme: scheme }), javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
      try {
        await guardBrowserContext(context);
        await context.route('**/*', (route) => {
          const request = route.request();
          if (blocked.size < 50) blocked.set(redact(request.url()).slice(0, 300), request.resourceType());
          // A refused navigation (a meta refresh, a frame) answers 204 so the browser stays on the tile instead of an error page.
          return request.isNavigationRequest() ? route.fulfill({ status: 204, body: '' }) : route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        await page.setContent(input.html, { waitUntil: 'load', timeout: input.timeoutSec * 1000 });
        const size = await page.locator('html').boundingBox();
        const width = VIEWPORTS[input.viewport].width;
        const full = Math.max(1, Math.ceil(size?.height ?? VIEWPORTS[input.viewport].height));
        const height = Math.min(full, MAX_TILE_HEIGHT);
        const png = await page.screenshot({ type: 'png', fullPage: true, clip: { x: 0, y: 0, width, height }, timeout: input.timeoutSec * 1000 });
        const name = `tile-${input.name}-${scheme}.png`;
        let screenshot: { id: string; name: string } | null;
        if (ctx.artifacts) screenshot = await ctx.artifacts.write({ name, type: 'screenshot', content: png, mime: 'image/png' });
        else {
          const dir = path.join(ctx.tempDir, 'screenshots');
          mkdirSync(dir, { recursive: true });
          const { writeFile } = await import('node:fs/promises');
          await writeFile(path.join(dir, name), png);
          screenshot = { id: path.join(dir, name), name };
        }
        let image: ResultImage | null = png.length <= MAX_MODEL_IMAGE_BYTES ? { name, mime: 'image/png', data: png } : null;
        for (const quality of [85, 70, 55]) {
          if (image) break;
          const jpeg = await page.screenshot({ type: 'jpeg', quality, fullPage: true, clip: { x: 0, y: 0, width, height }, timeout: input.timeoutSec * 1000 });
          if (jpeg.length <= MAX_MODEL_IMAGE_BYTES) image = { name: name.replace(/\.png$/, '.jpg'), mime: 'image/jpeg', data: jpeg };
        }
        if (image) images.push(image);
        tiles.push({ colorScheme: scheme, width, height, clipped: full > height, screenshot });
      } finally {
        await context.close();
      }
    }
    const refused = [...blocked].map(([url, type]) => ({ url, type }));
    const hosts = [...new Set(refused.map((r) => /^[a-z][\w+.-]*:\/\/([^/?#]+)/i.exec(r.url)?.[1] ?? r.url.slice(0, 40)))];
    const clipped = tiles.some((t) => t.clipped);
    return {
      ok: true,
      summary: `Rendered ${input.name} at ${input.viewport} ${VIEWPORTS[input.viewport].width} px in ${input.colorSchemes.join(' and ')}${clipped ? `, cut at ${MAX_TILE_HEIGHT} px` : ''}${refused.length ? `; ${refused.length} outside request(s) refused (${hosts.slice(0, 3).join(', ')}): inline them as data: URLs or use system fonts` : ''}`,
      output: { tiles, refusedRequests: refused },
      artifacts: tiles.flatMap((t) => (t.screenshot ? [t.screenshot] : [])),
      evidence: [`rendered ${input.name} (${input.colorSchemes.join(', ')}) with scripts off and the network refused`],
      ...(images.length ? { images } : {}),
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
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
  z.object({ action: z.literal('set_viewport'), viewport: viewportField }),
  z.object({ action: z.literal('screenshot'), name: z.string().min(1).max(60).regex(/^[\w-]+$/) }),
  z.object({ action: z.literal('download'), selector: z.string().min(1).max(500) }),
]);
type FlowStep = z.infer<typeof flowStep>;

async function runStep(ctx: OperationContext, page: Page, step: FlowStep, log: string[], artifacts: Array<{ id: string; name: string }>, images: ResultImage[]): Promise<void> {
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
      const shot = await saveScreenshot(ctx, page, `${step.name}.png`, images);
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

export const sessionName = z.string().min(1).max(60).regex(/^[\w-]+$/);

export function sessionFile(ctx: OperationContext, name: string): string {
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

/** `extra`: more operations on the same browser (the interactive pages in browser-session.ts). */
export function browserProvider(extra: ToolOperation[] = []): ToolProvider {
  return {
    id: 'playwright',
    name: 'Playwright',
    description: 'Headless Chromium for page checks, flows, screenshots, accessibility scans, pages an agent keeps open and drives step by step, and reading web pages.',
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
          viewports: z.array(viewportField).min(1).max(5).default(['desktop', 'phone']),
          waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load'),
          settleMs: z.number().int().min(0).max(10_000).default(800),
          sameOriginOnly: z.boolean().default(true),
          screenshot: z.boolean().default(true),
          timeoutSec: z.number().int().min(5).max(120).default(30),
          ...displayFields,
        }),
        level: 1,
        classify: (input) => ({ effects: isLoopback(input.url) ? [] : ['network'] }),
        run: (input, ctx) => checkPage(ctx, input),
      }),
      operation({
        id: 'browser.screenshot',
        title: 'Screenshot a page',
        description: 'Capture a page at a viewport; the picture is returned for you to look at.',
        input: z.object({ url: httpUrl, viewport: viewportField.default('desktop'), timeoutSec: z.number().int().min(5).max(120).default(30), ...displayFields }),
        level: 1,
        async run(input, ctx) {
          return withBrowser(async (browser) => {
            const images: ResultImage[] = [];
            const o = await checkAt(ctx, browser, { url: input.url, waitUntil: 'load', settleMs: 500, sameOriginOnly: true, screenshot: true, timeoutSec: input.timeoutSec, colorScheme: input.colorScheme, reducedMotion: input.reducedMotion, deviceScaleFactor: input.deviceScaleFactor }, input.viewport, images);
            return { ok: Boolean(o.screenshot), summary: o.screenshot ? `Saved ${o.screenshot.name}` : 'Screenshot failed', artifacts: o.screenshot ? [o.screenshot] : [], output: { status: o.status, title: o.title }, ...(images.length ? { images } : {}) };
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
          viewport: viewportField.default('desktop'),
          session: sessionName.optional(),
          saveSession: z.boolean().default(false),
          timeoutSec: z.number().int().min(5).max(600).default(120),
          ...displayFields,
        }),
        level: 2,
        classify: () => ({ reasons: ['Interacts with a page (may submit forms)'], effects: ['network'] }),
        async run(input, ctx) {
          return withBrowser(async (browser) => {
            const stateFile = input.session ? sessionFile(ctx, input.session) : null;
            const context: BrowserContext = await browser.newContext({
              ...contextOptions(input.viewport, input),
              acceptDownloads: true,
              ...(stateFile && existsSync(stateFile) ? { storageState: stateFile } : {}),
            });
            await guardBrowserContext(context);
            context.setDefaultTimeout(Math.min(30_000, input.timeoutSec * 1000));
            const log: string[] = [];
            const artifacts: Array<{ id: string; name: string }> = [];
            const images: ResultImage[] = [];
            try {
              const page = await context.newPage();
              const seen = observe(page, new URL(input.url).origin, true);
              await page.goto(input.url, { waitUntil: 'load', timeout: input.timeoutSec * 1000 });
              let failedAt: string | null = null;
              for (const [i, step] of input.steps.entries()) {
                try {
                  await runStep(ctx, page, step, log, artifacts, images);
                } catch (error) {
                  failedAt = `step ${i + 1} (${step.action}): ${redact((error as Error).message).split('\n')[0]}`;
                  artifacts.push(...[await saveScreenshot(ctx, page, `flow-failure-step-${i + 1}.png`, images).catch(() => null)].filter((a): a is { id: string; name: string } => a !== null));
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
                ...(images.length ? { images: images.slice(-3) } : {}),
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
        description:
          'Run axe-core (WCAG 2.2 AA rules) on a page and list violations with the elements that fail (CSS selectors), at a viewport and colour scheme: scan both themes, since contrast differs between them.',
        input: z.object({ url: httpUrl, viewport: viewportField.default('desktop'), ...displayFields }),
        level: 1,
        async run(input) {
          const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
          return withBrowser(async (browser) => {
            const context = await browser.newContext(contextOptions(input.viewport, input));
            await guardBrowserContext(context);
            try {
              const page = await context.newPage();
              await page.goto(input.url, { waitUntil: 'load', timeout: 30_000 });
              await page.addScriptTag({ content: axeSource });
              const result = (await page.evaluate(async () => {
                const axe = (globalThis as any).axe;
                const r = await axe.run((globalThis as any).document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
                return r.violations.map((v: any) => ({
                  id: v.id,
                  impact: v.impact,
                  help: v.help,
                  nodes: v.nodes.length,
                  // Which elements fail, so a fix can go straight to them.
                  targets: v.nodes.slice(0, 10).map((n: any) => ({ target: (n.target ?? []).join(' ').slice(0, 300), html: String(n.html ?? '').slice(0, 200), summary: String(n.failureSummary ?? '').slice(0, 300) })),
                }));
              })) as Array<{ id: string; impact: string; help: string; nodes: number; targets: Array<{ target: string; html: string; summary: string }> }>;
              for (const v of result) {
                for (const n of v.targets) {
                  n.html = redact(n.html);
                  n.summary = redact(n.summary);
                }
              }
              return {
                ok: result.length === 0,
                summary: result.length ? `${result.length} accessibility violation(s)${input.colorScheme ? ` (${input.colorScheme})` : ''}: ${result.map((v) => `${v.id} at ${v.targets[0]?.target ?? '?'}`).slice(0, 5).join(', ')}` : `No WCAG A/AA violations found${input.colorScheme ? ` (${input.colorScheme})` : ''}`,
                output: { violations: result, viewport: input.viewport, colorScheme: input.colorScheme ?? 'light' },
                evidence: [`axe on ${input.url} (${input.viewport}${input.colorScheme ? `, ${input.colorScheme}` : ''}): ${result.length} violation(s)`],
                ...(result.length ? { error: { code: 'FAILED' as const, message: `${result.length} violation(s)` } } : {}),
              };
            } finally {
              await context.close();
            }
          });
        },
      }),
      operation({
        id: 'browser.visual_matrix',
        title: 'See a page at every width and in both themes',
        description:
          'Open a URL at several widths (phone to wide desktop) in light and dark, and get one contact sheet per colour scheme to compare side by side, plus HTTP status, console errors and horizontal overflow for every view. Use it after a UI change to check layout, theme parity and reflow at once.',
        input: z.object({
          url: httpUrl,
          viewports: z.array(viewportField).min(1).max(5).default(['phone', 'tablet', 'desktop', 'wide']),
          colorSchemes: z.array(z.enum(['light', 'dark'])).min(1).max(2).default(['light', 'dark']),
          reducedMotion: displayFields.reducedMotion,
          settleMs: z.number().int().min(0).max(10_000).default(800),
          timeoutSec: z.number().int().min(5).max(120).default(30),
        }),
        level: 1,
        classify: (input) => ({ effects: isLoopback(input.url) ? [] : ['network'] }),
        run: (input, ctx) => visualMatrix(ctx, input),
      }),
      operation({
        id: 'browser.render_html',
        title: 'Draw a style tile or other self-contained HTML',
        description:
          'Draw HTML you wrote (a style tile: colour roles, type scale, buttons and states, spacing, an image mood) at one width in light and dark, and get the pictures back. Scripts are off and nothing is fetched: only data: URLs load, and every outside reference (a web font, a CDN stylesheet, a remote image) is refused and listed. Use it to compare art directions before any code is written.',
        input: z.object({
          html: z.string().min(1).max(MAX_TILE_HTML).describe('A complete, self-contained HTML document: inline <style>, data: images, system fonts.'),
          name: z.string().min(1).max(60).regex(/^[\w-]+$/).default('style-tile').describe('Names the saved pictures (tile-<name>-light.png).'),
          viewport: viewportField.default('desktop'),
          colorSchemes: z.array(z.enum(['light', 'dark'])).min(1).max(2).default(['light', 'dark']),
          timeoutSec: z.number().int().min(5).max(60).default(20),
        }),
        level: 1,
        readOnly: true,
        classify: () => ({ reasons: ['Draws HTML offline with scripts off'], effects: [], writes: false }),
        run: (input, ctx) => renderHtml(ctx, input),
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
      ...extra,
    ],
  };
}
