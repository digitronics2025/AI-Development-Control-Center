import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { redact } from '@acc/security';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';
import { z } from 'zod';
import { resolveInside } from '../paths.js';
import { failure, operation, type OperationContext, type OperationResult, type ResultImage, type ToolOperation } from '../sdk.js';
import { captureScreenshot, httpUrl, isLoopback, launch, sessionFile, sessionName, VIEWPORTS } from './browser.js';

/**
 * Pages an agent keeps open and drives step by step — the way an operator
 * works a browser by hand: open, look, act on what it sees, look again.
 *
 * - **Look** returns the page as an AI snapshot (Playwright's accessibility
 *   tree with `[ref=e12]` handles) and, on request, a screenshot the model
 *   sees. **Act** targets an element by that ref, or by a selector.
 * - Every page gets its own empty browser context: no cookies from anyone's
 *   profile. A signed-in state saved earlier with `saveSession` can be loaded
 *   by name; it lives in the Control Center's private folder.
 * - A page belongs to the task (or operator) that opened it. It closes on
 *   `browser.close`, when its task ends, or after ten idle minutes.
 */

const IDLE_MS = 10 * 60_000;
const MAX_PAGES_PER_OWNER = 4;
const MAX_PAGES = 12;
const MAX_LOG_LINES = 300;
const MAX_SNAPSHOT_CHARS = 14_000;
const MAX_TEXT_CHARS = 60_000;
/** How long a click is given to open a new tab before the page is looked at. */
const POPUP_WAIT_MS = 400;

interface LogLine {
  at: number;
  kind: 'console' | 'pageerror' | 'dialog' | 'request';
  level: 'error' | 'warning' | 'info';
  text: string;
}

interface OpenPage {
  id: string;
  owner: string;
  context: BrowserContext;
  page: Page;
  visible: boolean;
  log: LogLine[];
  /** Index into `log` up to which problems have been reported to the agent. */
  reported: number;
  dialogs: 'accept' | 'dismiss';
  lastUsed: number;
}

const pages = new Map<string, OpenPage>();
const browsers = new Map<'headless' | 'visible', Promise<Browser>>();
let sweeper: NodeJS.Timeout | null = null;

function ownerOf(ctx: OperationContext): string {
  return ctx.taskId ?? 'operator';
}

function browserFor(visible: boolean): Promise<Browser> {
  const key = visible ? 'visible' : 'headless';
  let pending = browsers.get(key);
  if (!pending) {
    pending = launch({ headless: !visible }).then((browser) => {
      browser.on('disconnected', () => {
        browsers.delete(key);
        for (const p of [...pages.values()]) if (p.visible === visible) pages.delete(p.id);
      });
      return browser;
    });
    pending.catch(() => browsers.delete(key));
    browsers.set(key, pending);
  }
  return pending;
}

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const p of [...pages.values()]) if (p.lastUsed < cutoff) void closePage(p);
  }, 60_000);
  sweeper.unref();
}

async function closePage(p: OpenPage): Promise<void> {
  pages.delete(p.id);
  await p.context.close().catch(() => undefined);
  const stillUsed = (visible: boolean) => [...pages.values()].some((o) => o.visible === visible);
  for (const visible of [false, true]) {
    const key = visible ? 'visible' : 'headless';
    const browser = browsers.get(key);
    if (browser && !stillUsed(visible)) {
      browsers.delete(key);
      await browser.then((b) => b.close()).catch(() => undefined);
    }
  }
  if (!pages.size && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/** Close every page a task opened (called when the task stops). Returns how many closed. */
export async function closeBrowserPages(owner: string): Promise<number> {
  const mine = [...pages.values()].filter((p) => p.owner === owner);
  for (const p of mine) await closePage(p);
  return mine.length;
}

/** Close everything (orchestrator shutdown, tests). */
export async function closeAllBrowserPages(): Promise<void> {
  for (const p of [...pages.values()]) await closePage(p);
}

export function openBrowserPages(owner?: string): Array<{ id: string; owner: string; url: string; visible: boolean }> {
  return [...pages.values()].filter((p) => !owner || p.owner === owner).map((p) => ({ id: p.id, owner: p.owner, url: redact(p.page.url()), visible: p.visible }));
}

function record(p: OpenPage, line: Omit<LogLine, 'at'>): void {
  p.log.push({ ...line, text: redact(line.text).slice(0, 800), at: Date.now() });
  if (p.log.length > MAX_LOG_LINES) {
    const drop = p.log.length - MAX_LOG_LINES;
    p.log.splice(0, drop);
    p.reported = Math.max(0, p.reported - drop);
  }
}

/** Chromium asks every site for /favicon.ico on its own; a missing one is not the page's fault. */
const isFavicon = (url: string) => /\/favicon\.ico(?:$|\?)/.test(url);

function watch(p: OpenPage, page: Page): void {
  page.on('console', (msg) => {
    const type = msg.type();
    const level = type === 'error' && !isFavicon(msg.location().url) ? 'error' : type === 'warning' ? 'warning' : 'info';
    record(p, { kind: 'console', level, text: `${type}: ${msg.text()}` });
  });
  page.on('pageerror', (err) => record(p, { kind: 'pageerror', level: 'error', text: err.message }));
  page.on('requestfailed', (req) => {
    const reason = req.failure()?.errorText ?? 'failed';
    if (!/ERR_ABORTED/.test(reason)) record(p, { kind: 'request', level: 'error', text: `${req.method()} ${req.url()} failed: ${reason}` });
  });
  page.on('response', (res) => {
    const status = res.status();
    const problem = status >= 400 && !isFavicon(res.url());
    record(p, { kind: 'request', level: problem ? 'error' : 'info', text: `${res.request().method()} ${res.url()} → ${status}` });
  });
  page.on('dialog', (dialog) => {
    record(p, { kind: 'dialog', level: 'warning', text: `${dialog.type()} "${dialog.message()}" → ${p.dialogs}ed` });
    void (p.dialogs === 'accept' ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
  });
}

/** A popup (target=_blank, window.open) becomes the page the agent drives, so it can follow the link. */
function followPopups(p: OpenPage): void {
  p.context.on('page', (popup) => {
    if (popup === p.page) return;
    record(p, { kind: 'console', level: 'info', text: `opened a new tab: ${popup.url() || 'about:blank'} (now driving it)` });
    p.page = popup;
    watch(p, popup);
  });
}

function pageFor(ctx: OperationContext, pageId: string): OpenPage | OperationResult {
  const p = pages.get(pageId);
  const owner = ownerOf(ctx);
  if (!p || p.owner !== owner) {
    const open = openBrowserPages(owner).map((o) => `${o.id} (${o.url})`);
    return failure('INVALID_INPUT', `No open page "${pageId}"${open.length ? `; open pages: ${open.join(', ')}` : '; open one with browser.open'}`);
  }
  p.lastUsed = Date.now();
  return p;
}

const isResult = (v: OpenPage | OperationResult): v is OperationResult => 'ok' in v;

/** Problems logged since the agent last looked. */
function newProblems(p: OpenPage): string[] {
  const lines = p.log.slice(p.reported).filter((l) => l.level === 'error' || l.kind === 'dialog');
  p.reported = p.log.length;
  return lines.map((l) => l.text);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => undefined);
}

async function snapshotText(page: Page, depth?: number): Promise<string> {
  const text = await page.ariaSnapshot({ mode: 'ai', ...(depth ? { depth } : {}) }).catch((error: Error) => `(no snapshot: ${error.message.split('\n')[0]})`);
  const clean = redact(text);
  return clean.length > MAX_SNAPSHOT_CHARS ? `${clean.slice(0, MAX_SNAPSHOT_CHARS)}\n… (snapshot cut at ${MAX_SNAPSHOT_CHARS} characters; pass a smaller \`depth\`, or read text with browser.evaluate)` : clean;
}

interface LookOptions {
  screenshot: boolean;
  fullPage?: boolean;
  depth?: number;
  lead: string;
  evidence?: string[];
}

/** The page as the agent sees it after every call: where it is, what is on it, what went wrong. */
async function look(ctx: OperationContext, p: OpenPage, opts: LookOptions): Promise<OperationResult> {
  const { page } = p;
  const title = redact(await page.title().catch(() => ''));
  const url = redact(page.url());
  const snapshot = await snapshotText(page, opts.depth);
  const problems = newProblems(p);
  const images: ResultImage[] = [];
  const artifacts: Array<{ id: string; name: string }> = [];
  if (opts.screenshot) {
    const shot = await captureScreenshot(ctx, page, `${p.id}-${Date.now()}.png`, opts.fullPage ?? false).catch(() => null);
    if (shot?.saved) artifacts.push(shot.saved);
    if (shot?.image) images.push(shot.image);
  }
  const stdout = [`Page ${p.id} · ${title || '(no title)'} · ${url}`, problems.length ? `New problems:\n${problems.map((l) => `- ${l}`).join('\n')}` : 'No new console errors or failed requests.', `Snapshot (act on an element with its ref, e.g. {"ref": "e12"}):\n${snapshot}`].join('\n\n');
  return {
    ok: true,
    summary: `${opts.lead} · ${title || url}${problems.length ? ` · ${problems.length} new problem(s)` : ''}`,
    output: { pageId: p.id, url, title, problems },
    stdout,
    artifacts,
    evidence: opts.evidence,
    networkTargets: /^https?:/i.test(page.url()) ? [new URL(page.url()).host] : [],
    ...(images.length ? { images } : {}),
  };
}

const pageId = z.string().min(1).max(40).regex(/^pg-[\w-]+$/, 'A page id from browser.open, e.g. "pg-1a2b3c"');
const viewport = z.enum(['desktop', 'phone', 'tablet']);
const ref = z.string().regex(/^(?:f\d+)?e\d+$/, 'A ref from the snapshot, e.g. "e12"');

const ACTIONS = ['click', 'double_click', 'hover', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'upload', 'scroll', 'goto', 'back', 'forward', 'reload', 'wait', 'set_viewport', 'dialogs'] as const;

const actInput = z
  .object({
    pageId,
    action: z.enum(ACTIONS),
    ref: ref.optional(),
    selector: z.string().min(1).max(500).optional(),
    value: z.string().max(10_000).optional(),
    values: z.array(z.string().max(500)).max(50).optional(),
    url: httpUrl.optional(),
    key: z.string().min(1).max(50).optional(),
    file: z.string().min(1).max(1000).optional(),
    viewport: viewport.optional(),
    text: z.string().min(1).max(500).optional(),
    timeoutSec: z.number().int().min(1).max(60).default(10),
    screenshot: z.boolean().default(false),
  })
  .superRefine((i, issue) => {
    const needsTarget = ['click', 'double_click', 'hover', 'fill', 'type', 'select', 'check', 'uncheck', 'upload'];
    if (needsTarget.includes(i.action) && !i.ref && !i.selector) issue.addIssue({ code: 'custom', message: `${i.action} needs a ref from the snapshot (or a selector)` });
    if ((i.action === 'fill' || i.action === 'type') && i.value === undefined) issue.addIssue({ code: 'custom', message: `${i.action} needs a value` });
    if (i.action === 'select' && i.value === undefined && !i.values) issue.addIssue({ code: 'custom', message: 'select needs a value (or values)' });
    if (i.action === 'press' && !i.key) issue.addIssue({ code: 'custom', message: 'press needs a key, e.g. "Enter"' });
    if (i.action === 'upload' && !i.file) issue.addIssue({ code: 'custom', message: 'upload needs a file inside the repository' });
    if (i.action === 'goto' && !i.url) issue.addIssue({ code: 'custom', message: 'goto needs a url' });
    if (i.action === 'set_viewport' && !i.viewport) issue.addIssue({ code: 'custom', message: 'set_viewport needs a viewport' });
    if (i.action === 'dialogs' && i.value !== 'accept' && i.value !== 'dismiss') issue.addIssue({ code: 'custom', message: 'dialogs needs value "accept" or "dismiss"' });
  });
type ActInput = z.infer<typeof actInput>;

function target(page: Page, input: ActInput): Locator {
  return input.ref ? page.locator(`aria-ref=${input.ref}`) : page.locator(input.selector!).first();
}

async function perform(ctx: OperationContext, p: OpenPage, input: ActInput): Promise<string> {
  const timeout = input.timeoutSec * 1000;
  const what = input.ref ?? input.selector ?? '';
  const page = p.page;
  switch (input.action) {
    case 'click':
      await target(page, input).click({ timeout });
      return `clicked ${what}`;
    case 'double_click':
      await target(page, input).dblclick({ timeout });
      return `double-clicked ${what}`;
    case 'hover':
      await target(page, input).hover({ timeout });
      return `hovered ${what}`;
    case 'fill':
      await target(page, input).fill(input.value!, { timeout });
      return `filled ${what}`;
    case 'type':
      await target(page, input).pressSequentially(input.value!, { timeout, delay: 20 });
      return `typed into ${what}`;
    case 'press':
      if (input.ref || input.selector) await target(page, input).press(input.key!, { timeout });
      else await page.keyboard.press(input.key!);
      return `pressed ${input.key}`;
    case 'select':
      await target(page, input).selectOption(input.values ?? input.value!, { timeout });
      return `selected ${(input.values ?? [input.value]).join(', ')} in ${what}`;
    case 'check':
      await target(page, input).check({ timeout });
      return `checked ${what}`;
    case 'uncheck':
      await target(page, input).uncheck({ timeout });
      return `unchecked ${what}`;
    case 'upload':
      await target(page, input).setInputFiles(resolveInside(ctx.roots, ctx.cwd, input.file!), { timeout });
      return `uploaded ${input.file}`;
    case 'scroll':
      if (input.ref || input.selector) await target(page, input).scrollIntoViewIfNeeded({ timeout });
      else await page.mouse.wheel(0, Number(input.value ?? 800) || 800);
      return input.ref || input.selector ? `scrolled to ${what}` : 'scrolled down';
    case 'goto':
      await page.goto(input.url!, { waitUntil: 'domcontentloaded', timeout: Math.max(timeout, 30_000) });
      return `went to ${redact(input.url!)}`;
    case 'back':
      await page.goBack({ waitUntil: 'domcontentloaded', timeout });
      return 'went back';
    case 'forward':
      await page.goForward({ waitUntil: 'domcontentloaded', timeout });
      return 'went forward';
    case 'reload':
      await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.max(timeout, 30_000) });
      return 'reloaded';
    case 'wait':
      if (input.text) await page.getByText(input.text).first().waitFor({ timeout });
      else if (input.ref || input.selector) await target(page, input).waitFor({ timeout });
      else await page.waitForTimeout(Math.min(timeout, 10_000));
      return input.text ? `saw "${input.text}"` : input.ref || input.selector ? `${what} appeared` : `waited ${Math.min(input.timeoutSec, 10)}s`;
    case 'set_viewport': {
      const vp = VIEWPORTS[input.viewport!];
      await page.setViewportSize({ width: vp.width, height: vp.height });
      return `viewport ${input.viewport}`;
    }
    case 'dialogs':
      p.dialogs = input.value as 'accept' | 'dismiss';
      return `dialogs will be ${p.dialogs}ed`;
  }
}

/** Playwright's first error line, with the hint that matters most to an agent. */
function explain(error: Error, input: ActInput): string {
  const first = redact(error.message).split('\n')[0]!.slice(0, 400);
  if (input.ref && /aria-ref|not found|resolved to 0|Timeout/i.test(error.message)) return `${first} — ${input.ref} may be stale; take a fresh browser.snapshot and use a ref from it`;
  return first;
}

/** Wrap a script so both an expression (`document.title`) and a function (`() => …`) work. */
export function asEvaluable(script: string): string {
  const s = script.trim();
  return /^(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(s) ? `(${s})()` : s;
}

export function browserPageOperations(): ToolOperation[] {
  return [
    operation({
      id: 'browser.open',
      title: 'Open a page to work on',
      description:
        'Open a URL in a browser page that stays open between calls, and see it: an accessibility snapshot with element refs (act on them with browser.act) plus a screenshot. Use it to check a change the way a person would: open, look, click, look again. `session` loads a signed-in state saved earlier; `visible` shows the window on the operator’s screen.',
      input: z.object({
        url: httpUrl,
        viewport: viewport.default('desktop'),
        session: sessionName.optional(),
        visible: z.boolean().default(false),
        screenshot: z.boolean().default(true),
        timeoutSec: z.number().int().min(5).max(120).default(30),
      }),
      level: 1,
      classify: (input) => ({ effects: isLoopback(input.url) ? [] : ['network'] }),
      async run(input, ctx) {
        const owner = ownerOf(ctx);
        if (openBrowserPages(owner).length >= MAX_PAGES_PER_OWNER) return failure('UNAVAILABLE', `Already ${MAX_PAGES_PER_OWNER} pages open (${openBrowserPages(owner).map((o) => o.id).join(', ')}); close one with browser.close`);
        if (pages.size >= MAX_PAGES) return failure('UNAVAILABLE', `The Control Center already has ${MAX_PAGES} browser pages open; try again when one closes`);
        const vp = VIEWPORTS[input.viewport];
        const stateFile = input.session ? sessionFile(ctx, input.session) : null;
        if (stateFile && !existsSync(stateFile)) return failure('INVALID_INPUT', `No saved session "${input.session}"; sign in on a page, then browser.close with saveSession`);
        let visible = input.visible;
        let browser: Browser;
        try {
          browser = await browserFor(visible);
        } catch (error) {
          if (!visible) throw error;
          // No desktop to show a window on (a service or remote session): work headless instead.
          visible = false;
          browser = await browserFor(false);
        }
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          isMobile: vp.isMobile,
          hasTouch: vp.isMobile,
          acceptDownloads: false,
          ...(stateFile ? { storageState: stateFile } : {}),
        });
        const p: OpenPage = { id: `pg-${randomBytes(4).toString('hex')}`, owner, context, page: await context.newPage(), visible, log: [], reported: 0, dialogs: 'dismiss', lastUsed: Date.now() };
        pages.set(p.id, p);
        startSweeper();
        watch(p, p.page);
        followPopups(p);
        let status: number | null = null;
        try {
          const response = await p.page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: input.timeoutSec * 1000 });
          status = response?.status() ?? null;
        } catch (error) {
          record(p, { kind: 'pageerror', level: 'error', text: `Navigation failed: ${(error as Error).message.split('\n')[0]}` });
        }
        await settle(p.page);
        const result = await look(ctx, p, { screenshot: input.screenshot, lead: `Opened ${p.id}${status ? ` (HTTP ${status})` : ''}${visible ? ' in a visible window' : ''}${input.visible && !visible ? ' (no desktop for a visible window; headless)' : ''}`, evidence: [`opened ${redact(input.url)} → ${status ?? 'no response'}`] });
        return { ...result, output: { ...(result.output as object), status, visible } };
      },
    }),
    operation({
      id: 'browser.snapshot',
      title: 'Look at an open page',
      description: 'See an open page again: its accessibility snapshot with element refs, anything that went wrong since the last look, and (with screenshot) a picture of it.',
      input: z.object({ pageId, screenshot: z.boolean().default(false), fullPage: z.boolean().default(false), depth: z.number().int().min(1).max(50).optional() }),
      level: 1,
      async run(input, ctx) {
        const p = pageFor(ctx, input.pageId);
        if (isResult(p)) return p;
        return look(ctx, p, { screenshot: input.screenshot, fullPage: input.fullPage, depth: input.depth, lead: `Looked at ${p.id}` });
      },
    }),
    operation({
      id: 'browser.act',
      title: 'Act on an open page',
      description:
        'Do one thing on an open page — click, double_click, hover, fill, type, press, select, check, uncheck, upload, scroll, goto, back, forward, reload, wait (for text or an element), set_viewport, dialogs (accept|dismiss) — then get the new snapshot. Target an element with `ref` from the latest snapshot, or a `selector`.',
      input: actInput,
      level: 2,
      classify: (input) => ({ reasons: ['Interacts with a page (may submit forms)'], effects: input.url && isLoopback(input.url) ? [] : ['network'] }),
      async run(input, ctx) {
        const p = pageFor(ctx, input.pageId);
        if (isResult(p)) return p;
        // A click or key press may open a new tab (target=_blank, window.open); give it a moment to appear.
        const mayOpenTab = input.action === 'click' || input.action === 'double_click' || input.action === 'press';
        const popup = mayOpenTab ? p.context.waitForEvent('page', { timeout: POPUP_WAIT_MS }).catch(() => null) : Promise.resolve(null);
        let done: string;
        try {
          done = await perform(ctx, p, input);
        } catch (error) {
          const why = explain(error as Error, input);
          const after = await look(ctx, p, { screenshot: input.screenshot, lead: `${input.action} failed` });
          return { ...after, ok: false, summary: `${input.action} ${input.ref ?? input.selector ?? ''} failed: ${why}`.replace(/\s+/g, ' '), error: { code: 'FAILED', message: why } };
        }
        const opened = await popup;
        await settle(opened ?? p.page);
        return look(ctx, p, { screenshot: input.screenshot, lead: done.charAt(0).toUpperCase() + done.slice(1), evidence: [`${p.id}: ${done}`] });
      },
    }),
    operation({
      id: 'browser.evaluate',
      title: 'Run a script in an open page',
      description: 'Evaluate JavaScript in an open page and get the JSON result: an expression (`document.title`) or a function (`() => [...document.querySelectorAll("h2")].map(h => h.textContent)`). For reading what the snapshot does not show; prefer browser.act to change the page.',
      input: z.object({ pageId, script: z.string().min(1).max(20_000) }),
      level: 2,
      classify: () => ({ reasons: ['Runs code inside the page'] }),
      async run(input, ctx) {
        const p = pageFor(ctx, input.pageId);
        if (isResult(p)) return p;
        let value: unknown;
        try {
          value = await p.page.evaluate(asEvaluable(input.script));
        } catch (error) {
          return failure('FAILED', `Script failed: ${redact((error as Error).message).split('\n')[0]!.slice(0, 400)}`);
        }
        let text: string;
        try {
          text = value === undefined ? 'undefined' : JSON.stringify(value, null, 1);
        } catch {
          text = String(value);
        }
        text = redact(text);
        const problems = newProblems(p);
        return {
          ok: true,
          summary: `Script ran on ${p.id}${problems.length ? ` · ${problems.length} new problem(s)` : ''}`,
          stdout: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n… (cut at ${MAX_TEXT_CHARS} characters)` : text,
          output: { pageId: p.id, problems },
        };
      },
    }),
    operation({
      id: 'browser.logs',
      title: 'Console and network of an open page',
      description: 'What an open page logged and requested since it opened: console messages, page errors, dialogs and responses (with status). `onlyProblems` keeps errors and failed requests.',
      input: z.object({ pageId, kind: z.enum(['all', 'console', 'network']).default('all'), onlyProblems: z.boolean().default(false), limit: z.number().int().min(1).max(MAX_LOG_LINES).default(100) }),
      level: 1,
      async run(input, ctx) {
        const p = pageFor(ctx, input.pageId);
        if (isResult(p)) return p;
        const lines = p.log
          .filter((l) => input.kind === 'all' || (input.kind === 'network' ? l.kind === 'request' : l.kind !== 'request'))
          .filter((l) => !input.onlyProblems || l.level === 'error')
          .slice(-input.limit);
        p.reported = p.log.length;
        const errors = lines.filter((l) => l.level === 'error').length;
        return { ok: true, summary: `${lines.length} line(s) from ${p.id}, ${errors} error(s)`, stdout: lines.map((l) => `[${l.level}] ${l.text}`).join('\n') || '(nothing logged)', output: { pageId: p.id, count: lines.length, errors } };
      },
    }),
    operation({
      id: 'browser.close',
      title: 'Close an open page',
      description: 'Close a page from browser.open. `saveSession` keeps its signed-in state (cookies and storage) under a name for later browser.open / browser.run_flow calls; it is stored in the Control Center’s private folder, never in the repository.',
      input: z.object({ pageId, saveSession: sessionName.optional() }),
      level: 1,
      async run(input, ctx) {
        const p = pageFor(ctx, input.pageId);
        if (isResult(p)) return p;
        if (input.saveSession) {
          const file = sessionFile(ctx, input.saveSession);
          mkdirSync(path.dirname(file), { recursive: true });
          await p.context.storageState({ path: file });
        }
        await closePage(p);
        return { ok: true, summary: `Closed ${p.id}${input.saveSession ? ` and saved session "${input.saveSession}"` : ''}` };
      },
    }),
    operation({
      id: 'web.read',
      title: 'Read a web page',
      description: 'Load a URL in a real browser (so script-built pages work) and return its readable text and links — for documentation, error messages, release notes. Nothing is clicked or submitted.',
      input: z.object({ url: httpUrl, maxChars: z.number().int().min(500).max(MAX_TEXT_CHARS).default(20_000), links: z.boolean().default(true), timeoutSec: z.number().int().min(5).max(90).default(30) }),
      level: 1,
      classify: (input) => ({ effects: isLoopback(input.url) ? [] : ['network'] }),
      async run(input) {
        const browser = await launch();
        try {
          const context = await browser.newContext({ acceptDownloads: false });
          const page = await context.newPage();
          const response = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: input.timeoutSec * 1000 });
          await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
          const status = response?.status() ?? null;
          const read = (await page.evaluate(() => {
            // Runs in the page: DOM globals through globalThis (this package compiles without DOM types).
            const doc = (globalThis as any).document;
            const root = doc.querySelector('main, article, [role="main"]') ?? doc.body;
            const text = String(root?.innerText ?? '');
            const links = [...doc.querySelectorAll('a[href]')]
              .map((a: any) => ({ text: String(a.innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 120), href: String(a.href) }))
              .filter((l: { text: string; href: string }) => l.text && /^https?:/.test(l.href));
            return { text, links };
          })) as { text: string; links: Array<{ text: string; href: string }> };
          const title = redact(await page.title().catch(() => ''));
          const text = redact(read.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
          const seen = new Set<string>();
          const links = read.links.filter((l) => !seen.has(l.href) && seen.add(l.href)).slice(0, 60).map((l) => ({ text: l.text, href: redact(l.href) }));
          const body = text.length > input.maxChars ? `${text.slice(0, input.maxChars)}\n… (cut at ${input.maxChars} of ${text.length} characters; raise maxChars to read more)` : text;
          const finalUrl = redact(page.url());
          await context.close();
          const ok = status === null || status < 400;
          return {
            ok,
            summary: `${ok ? 'Read' : `HTTP ${status} from`} ${finalUrl}${title ? ` — ${title}` : ''} (${text.length} characters)`,
            stdout: `# ${title || finalUrl}\n${finalUrl}\n\n${body}${input.links && links.length ? `\n\nLinks:\n${links.map((l) => `- ${l.text}: ${l.href}`).join('\n')}` : ''}`,
            output: { url: finalUrl, status, title, characters: text.length },
            networkTargets: [new URL(input.url).host],
            ...(ok ? {} : { error: { code: 'FAILED' as const, message: `HTTP ${status}` } }),
          };
        } finally {
          await browser.close().catch(() => undefined);
        }
      },
    }),
  ];
}
