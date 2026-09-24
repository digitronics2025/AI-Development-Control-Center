import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveShell } from '@acc/executor';
import { builtinProviders, closeAllBrowserPages, closeBrowserPages, findBrowser, openBrowserPages, ToolHealthCache, ToolRegistry, ToolRouter, type OperationContext, type OperationResult } from '../src/index.js';
import { asEvaluable } from '../src/packs/browser-session.js';
import { decodeEntities, htmlToText, parseSearchResults } from '../src/packs/web.js';

/**
 * Pages an agent keeps open (browser.open / snapshot / act / evaluate / logs /
 * close) and the web pack, against a local HTTP server and a real headless
 * Chromium. Web search is tested on a saved results page, never the network.
 */

const registry = new ToolRegistry();
for (const p of builtinProviders()) registry.register(p);
const router = new ToolRouter(registry);
const temp = mkdtempSync(path.join(os.tmpdir(), 'acc-pages-'));
const health = new ToolHealthCache(registry, () => ({ env: process.env, cwd: temp, shell: (k) => resolveShell(k), tempDir: temp }));

function ctx(taskId: string | null = 'task-a'): OperationContext {
  return {
    executionId: 'test',
    taskId,
    cwd: temp,
    roots: [temp],
    env: process.env,
    signal: new AbortController().signal,
    timeoutMs: 60_000,
    tempDir: path.join(temp, 'scratch'),
    stateDir: path.join(temp, 'state'),
    shell: (k) => resolveShell(k),
    detection: (id) => health.get(id),
    protectedPaths: [],
  };
}

async function call(capability: string, input: unknown, context: OperationContext = ctx()): Promise<OperationResult> {
  const decision = router.route({ capability, detection: (id) => health.get(id) });
  if (!decision.ok) throw new Error(decision.reason);
  return decision.route.operation.run(decision.route.operation.input.parse(input), context);
}

/** Call one provider's operation directly (routing would pick the preferred provider). */
async function callOn(providerId: string, capability: string, input: unknown): Promise<OperationResult> {
  const op = registry.provider(providerId)!.operations.find((o) => o.id === capability)!;
  return op.run(op.input.parse(input), ctx());
}

const refOf = (snapshot: string, pattern: RegExp) => new RegExp(`${pattern.source}[^\\n]*\\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];

let server: http.Server;
let base: string;

const PAGES: Record<string, string> = {
  '/': `<!doctype html><title>Shop</title><main><h1>Orders</h1><label>Customer <input id="c"></label>
    <button onclick="console.error('saving failed once'); document.querySelector('h1').textContent = 'Saved ' + document.querySelector('#c').value">Save</button>
    <button onclick="document.querySelector('h1').textContent = confirm('Delete?') ? 'Deleted' : 'Kept'">Delete</button>
    <a href="/other" target="_blank">Open help</a></main>`,
  '/broken': `<!doctype html><title>Broken</title><h1>Broken</h1><script>fetch('/missing.json')</script>`,
  '/other': `<!doctype html><title>Help</title><main><h1>Help centre</h1><p>Returns take 14 days.</p><a href="https://example.com/terms">Terms</a></main>`,
  '/cookie': `<!doctype html><title>Cookie</title><script>document.cookie = 'signed=yes; path=/'</script><p>set</p>`,
};

beforeAll(async () => {
  await health.refresh({ ids: ['playwright', 'web'] });
  server = http.createServer((req, res) => {
    const page = PAGES[req.url ?? ''];
    if (!page) {
      res.statusCode = 404;
      res.end('nope');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(page);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
  await closeAllBrowserPages();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('web pack helpers', () => {
  it('reads search results, leaving out adverts and unwrapping redirects', () => {
    const html = `<div class="result results_links results_links_deep result--ad"><h2><a class="result__a" href="https://ads.example/x">Buy now</a></h2></div>
      <div class="result results_links results_links_deep web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://playwright.dev/docs/aria-snapshots">Snapshot testing | <b>Playwright</b></a></h2>
        <a class="result__snippet" href="https://playwright.dev/docs/aria-snapshots">&quot;<b>Aria</b> snapshot&quot; tab &amp; more</a></div>
      <div class="result results_links results_links_deep web-result "><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdevelopers.cloudflare.com%2Fd1%2F&amp;rut=abc">D1 docs</a></h2></div>`;
    expect(parseSearchResults(html)).toEqual([
      { title: 'Snapshot testing | Playwright', url: 'https://playwright.dev/docs/aria-snapshots', snippet: '"Aria snapshot" tab & more' },
      { title: 'D1 docs', url: 'https://developers.cloudflare.com/d1/', snippet: '' },
    ]);
  });

  it('turns HTML into readable text without scripts or styles', () => {
    const { title, text } = htmlToText('<html><head><title>A &amp; B</title><style>p{}</style></head><body><nav>x</nav><main><h1>Hello</h1><script>evil()</script><p>One&nbsp;two</p><ul><li>a</li><li>b</li></ul></main></body></html>');
    expect(title).toBe('A & B');
    expect(text).toBe('Hello\nOne two\n- a\n- b');
    expect(decodeEntities('&#39;x&#x27; &lt;y&gt;')).toBe("'x' <y>");
  });

  it('accepts an expression or a function in browser.evaluate', () => {
    expect(asEvaluable('document.title')).toBe('document.title');
    expect(asEvaluable('() => 1')).toBe('(() => 1)()');
    expect(asEvaluable('async () => { return 2 }')).toBe('(async () => { return 2 })()');
    expect(asEvaluable('function () { return 3 }')).toBe('(function () { return 3 })()');
  });

  it('reads a page as text without a browser (the fallback provider)', async () => {
    const r = await callOn('web', 'web.read', { url: `${base}/other` });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain('Returns take 14 days.');
    expect(r.stdout).toContain('- Terms: https://example.com/terms');
  });
});

const browser = await findBrowser();

describe.skipIf(!browser)('pages an agent keeps open (real Chromium)', () => {
  it('opens a page, shows it with refs and a picture, and acts on what it sees', async () => {
    const opened = await call('browser.open', { url: `${base}/` });
    expect(opened.ok).toBe(true);
    const { pageId } = opened.output as { pageId: string };
    expect(pageId).toMatch(/^pg-[0-9a-f]{8}$/);
    expect(opened.stdout).toMatch(/heading "Orders"/);
    // The server has no favicon; Chromium's own request for it is not the page's problem.
    expect((opened.output as { problems: string[] }).problems).toEqual([]);
    expect(opened.images).toHaveLength(1);
    expect(opened.images![0]!.data.subarray(1, 4).toString()).toBe('PNG');

    const box = refOf(opened.stdout!, /textbox "Customer"/)!;
    await call('browser.act', { pageId, action: 'fill', ref: box, value: 'Amina' });
    const save = refOf(opened.stdout!, /button "Save"/)!;
    const clicked = await call('browser.act', { pageId, action: 'click', ref: save });
    expect(clicked.ok).toBe(true);
    expect(clicked.stdout).toMatch(/heading "Saved Amina"/);
    // The console error from the click is reported once, then not again.
    expect((clicked.output as { problems: string[] }).problems).toEqual(['error: saving failed once']);
    const again = await call('browser.snapshot', { pageId });
    expect((again.output as { problems: string[] }).problems).toEqual([]);
    expect(again.images).toBeUndefined();

    const stale = await call('browser.act', { pageId, action: 'click', ref: 'e999', timeoutSec: 1 });
    expect(stale.ok).toBe(false);
    expect(stale.summary).toMatch(/take a fresh browser\.snapshot/);

    expect((await call('browser.evaluate', { pageId, script: 'document.title' })).stdout).toBe('"Shop"');
    expect((await call('browser.evaluate', { pageId, script: '() => [...document.querySelectorAll("button")].map((b) => b.textContent)' })).stdout).toContain('"Delete"');
    expect(await call('browser.evaluate', { pageId, script: 'throw new Error("x")' })).toMatchObject({ ok: false });

    // Dialogs are dismissed unless the agent says otherwise.
    const del = refOf(opened.stdout!, /button "Delete"/)!;
    expect((await call('browser.act', { pageId, action: 'click', ref: del })).stdout).toMatch(/heading "Kept"/);
    await call('browser.act', { pageId, action: 'dialogs', value: 'accept' });
    expect((await call('browser.act', { pageId, action: 'click', ref: del })).stdout).toMatch(/heading "Deleted"/);

    // A link that opens a new tab is followed.
    const help = refOf(opened.stdout!, /link "Open help"/)!;
    expect((await call('browser.act', { pageId, action: 'click', ref: help })).stdout).toMatch(/heading "Help centre"/);

    expect(await call('browser.close', { pageId })).toMatchObject({ ok: true });
    expect(await call('browser.snapshot', { pageId })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  }, 120_000);

  it('reports failed requests in the log', async () => {
    const opened = await call('browser.open', { url: `${base}/broken`, screenshot: false });
    const { pageId } = opened.output as { pageId: string };
    expect((opened.output as { problems: string[] }).problems.join('\n')).toMatch(/missing\.json → 404/);
    const logs = await call('browser.logs', { pageId, kind: 'network', onlyProblems: true });
    expect(logs.stdout).toMatch(/\[error\] GET .*missing\.json → 404/);
    await call('browser.close', { pageId });
  }, 60_000);

  it('keeps a page to the task that opened it and closes it when that task ends', async () => {
    const { pageId } = (await call('browser.open', { url: `${base}/`, screenshot: false }, ctx('task-owner'))).output as { pageId: string };
    const other = await call('browser.snapshot', { pageId }, ctx('task-other'));
    expect(other).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(openBrowserPages('task-owner')).toHaveLength(1);
    expect(await closeBrowserPages('task-owner')).toBe(1);
    expect(openBrowserPages('task-owner')).toHaveLength(0);
  }, 60_000);

  it('limits how many pages one task keeps open', async () => {
    const c = ctx('task-many');
    for (let i = 0; i < 4; i++) expect((await call('browser.open', { url: `${base}/other`, screenshot: false }, c)).ok).toBe(true);
    expect(await call('browser.open', { url: `${base}/other`, screenshot: false }, c)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    await closeBrowserPages('task-many');
  }, 90_000);

  it('saves a signed-in state on close and loads it by name', async () => {
    const { pageId } = (await call('browser.open', { url: `${base}/cookie`, screenshot: false })).output as { pageId: string };
    await call('browser.close', { pageId, saveSession: 'shop-owner' });
    const fresh = (await call('browser.open', { url: `${base}/other`, screenshot: false })).output as { pageId: string };
    expect((await call('browser.evaluate', { pageId: fresh.pageId, script: 'document.cookie' })).stdout).toBe('""');
    const signed = (await call('browser.open', { url: `${base}/other`, session: 'shop-owner', screenshot: false })).output as { pageId: string };
    expect((await call('browser.evaluate', { pageId: signed.pageId, script: 'document.cookie' })).stdout).toBe('"signed=yes"');
    expect(await call('browser.open', { url: `${base}/other`, session: 'nobody' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await closeBrowserPages('task-a');
  }, 90_000);

  it('reads a page through the browser and shows check_page screenshots to the model', async () => {
    const read = await call('web.read', { url: `${base}/other` });
    expect(read.ok).toBe(true);
    expect(read.stdout).toMatch(/^# Help\n/);
    expect(read.stdout).toContain('Returns take 14 days.');
    const checked = await call('browser.check_page', { url: `${base}/other`, viewports: ['desktop', 'phone'] });
    expect(checked.images?.map((i) => i.name)).toEqual(['other-desktop.png', 'other-phone.png']);
  }, 90_000);
});
