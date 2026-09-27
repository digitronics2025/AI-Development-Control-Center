import dgram from 'node:dgram';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
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
let diffColour = '#2255dd';
let dotColour = '#2255dd';

/** The pixels of a PNG Chromium drew (8-bit RGB or RGBA, not interlaced): `at(x, y)` is [r, g, b]. */
function pngPixels(png: Buffer): { width: number; height: number; at: (x: number, y: number) => number[] } {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (png[24] !== 8 || (png[25] !== 2 && png[25] !== 6) || png[28] !== 0) throw new Error('Not an 8-bit, non-interlaced RGB(A) PNG');
  const bpp = png[25] === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at)) if (png.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + png.readUInt32BE(at)));
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[y * stride + i - bpp]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predicted = [0, a, b, (a + b) >> 1, paeth][filter]!;
      out[y * stride + i] = (raw[y * (stride + 1) + 1 + i]! + predicted) & 0xff;
    }
  }
  return { width, height, at: (x, y) => [...out.subarray((y * width + x) * bpp, (y * width + x) * bpp + 3)] };
}

/** How many pixels of a PNG are magenta, the colour a script paints when it runs. */
function magentaPixels(png: Buffer): number {
  const { width, height, at } = pngPixels(png);
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = at(x, y) as [number, number, number];
      if (r > 220 && g < 40 && b > 220) n++;
    }
  }
  return n;
}

/** An uncompressed 24-bit BMP of the given size, a gradient so it is not blank. */
function bitmap(width: number, height: number): Buffer {
  const row = Math.ceil((width * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * height);
  buf.write('BM', 0, 'latin1');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) buf.set([x % 256, y % 256, (x + y) % 256], 54 + y * row + x * 3);
  return buf;
}

const PAGES: Record<string, string> = {
  '/': `<!doctype html><title>Shop</title><main><h1>Orders</h1><label>Customer <input id="c"></label>
    <button onclick="console.error('saving failed once'); document.querySelector('h1').textContent = 'Saved ' + document.querySelector('#c').value">Save</button>
    <button onclick="document.querySelector('h1').textContent = confirm('Delete?') ? 'Deleted' : 'Kept'">Delete</button>
    <a href="/other" target="_blank">Open help</a></main>`,
  '/broken': `<!doctype html><title>Broken</title><h1>Broken</h1><script>fetch('/missing.json')</script>`,
  '/other': `<!doctype html><title>Help</title><main><h1>Help centre</h1><p>Returns take 14 days.</p><a href="https://example.com/terms">Terms</a></main>`,
  '/cookie': `<!doctype html><title>Cookie</title><script>document.cookie = 'signed=yes; path=/'</script><p>set</p>`,
  '/whoami': `<!doctype html><title>Who</title><h1 id="c"></h1><script>document.getElementById('c').textContent = document.cookie</script>`,
  // Themes, motion and a layout that breaks at phone width (docs/systems/design-agent.md).
  '/heavy': `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Heavy</title><body style="margin:0;font:16px system-ui">
    <main><h1>Heavy page</h1><p style="height:300px;background:#cde">Content that the late banner pushes down.</p><img src="/big.bmp" alt="Hero" style="width:100px"><div style="height:2000px"></div><img src="/big.bmp" alt="Below" width="400" height="300"><video src="/none.mp4" muted></video></main>
    <script>setTimeout(() => { const d = document.createElement('div'); d.style.cssText = 'height:400px;background:#eee'; d.textContent = 'Late banner'; document.body.prepend(d); }, 700)</script></body></html>`,
  '/themed': `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Themed</title><style>
    :root { color-scheme: light dark; --bg: #ffffff; --fg: #111111; }
    @media (prefers-color-scheme: dark) { :root { --bg: #111111; --fg: #f5f5f5; } }
    body { background: var(--bg); color: var(--fg); font: 16px system-ui; margin: 0; }
    .wide { width: 600px; height: 40px; background: #4a7; }
    .faint { color: #d9d9d9; background: #ffffff; }
  </style><main><h1>Themed page</h1><p class="faint">Barely readable</p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10"><div class="wide"></div></main></html>`,
};

beforeAll(async () => {
  await health.refresh({ ids: ['playwright', 'web'] });
  server = http.createServer((req, res) => {
    // A 400×300 bitmap, far larger than it is shown and heavier than 200 KB (browser.audit).
    if (req.url === '/big.bmp') {
      res.setHeader('content-type', 'image/bmp');
      res.end(bitmap(400, 300));
      return;
    }
    // A box whose colour the visual-diff test changes between captures.
    if (req.url === '/diff') {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0;background:#fff}.box{width:200px;height:120px;margin:40px;background:${diffColour}}</style><div class="box"></div><p style="margin:40px;font:16px system-ui">Stable text</p>`);
      return;
    }
    // A 3×3 dot: a change too small to show as a rounded percentage (browser.visual_diff at threshold 0).
    if (req.url === '/dot') {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0;background:#fff}.dot{width:3px;height:3px;margin:40px;background:${dotColour}}</style><div class="dot"></div>`);
      return;
    }
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
    const signed = (await call('browser.open', { url: `${base}/whoami`, session: 'shop-owner', screenshot: false })).output as { pageId: string };
    expect((await call('browser.snapshot', { pageId: signed.pageId })).stdout).toMatch(/heading "signed=yes"/);
    // Scripts never run in a signed-in page: they could read its cookies and tokens (audit F-32).
    expect(await call('browser.evaluate', { pageId: signed.pageId, script: 'document.cookie' })).toMatchObject({ ok: false, error: { code: 'DENIED' } });
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

describe.skipIf(!browser)('design checks (real Chromium)', () => {
  it('shows a page as a dark-mode, reduced-motion, high-density screen would, at the wide and narrow-desktop widths', async () => {
    const opened = await call('browser.open', { url: `${base}/themed`, viewport: 'wide', colorScheme: 'dark', reducedMotion: 'reduce', deviceScaleFactor: 2, screenshot: false });
    expect(opened.ok, opened.summary).toBe(true);
    const { pageId } = opened.output as { pageId: string };
    const facts = await call('browser.evaluate', {
      pageId,
      script: '() => ({ dark: matchMedia("(prefers-color-scheme: dark)").matches, reduce: matchMedia("(prefers-reduced-motion: reduce)").matches, dpr: devicePixelRatio, width: innerWidth, bg: getComputedStyle(document.body).backgroundColor })',
    });
    expect(JSON.parse(facts.stdout!)).toEqual({ dark: true, reduce: true, dpr: 2, width: 1440, bg: 'rgb(17, 17, 17)' });
    await call('browser.act', { pageId, action: 'set_viewport', viewport: 'narrow-desktop' });
    expect((await call('browser.evaluate', { pageId, script: 'innerWidth' })).stdout).toBe('1024');
    await call('browser.close', { pageId });
    // A light page by default.
    const light = await call('browser.open', { url: `${base}/themed`, screenshot: false });
    const lightId = (light.output as { pageId: string }).pageId;
    expect((await call('browser.evaluate', { pageId: lightId, script: 'getComputedStyle(document.body).backgroundColor' })).stdout).toBe('"rgb(255, 255, 255)"');
    await call('browser.close', { pageId: lightId });
  }, 60_000);

  it('names the elements that fail an accessibility rule, per colour scheme', async () => {
    const r = await call('browser.accessibility', { url: `${base}/themed`, viewport: 'phone' });
    expect(r.ok).toBe(false);
    const violations = (r.output as { violations: Array<{ id: string; targets: Array<{ target: string; html: string }> }> }).violations;
    const contrast = violations.find((v) => v.id === 'color-contrast');
    // axe's own shortest unique selector for the faint paragraph.
    expect(contrast?.targets[0]?.target).toMatch(/^(?:p|\.faint)$/);
    expect(contrast?.targets[0]?.html).toContain('Barely readable');
    expect(violations.find((v) => v.id === 'image-alt')?.targets[0]?.target).toBe('img');
    expect(r.summary).toMatch(/color-contrast at (?:p|\.faint)/);
    const dark = await call('browser.accessibility', { url: `${base}/themed`, colorScheme: 'dark' });
    expect((dark.output as { colorScheme: string }).colorScheme).toBe('dark');
    expect(dark.summary).toContain('(dark)');
  }, 60_000);

  it('verifies a page at the chosen widths in each colour scheme', async () => {
    const r = await call('verify.web', { url: base, paths: ['/themed'], viewports: ['phone', 'desktop'], colorSchemes: ['light', 'dark'] });
    expect(r.ok).toBe(false);
    const problems = (r.output as { problems: string[] }).problems;
    expect(problems).toEqual(expect.arrayContaining(['/themed (light) phone: page scrolls horizontally', '/themed (dark) phone: page scrolls horizontally']));
    expect(problems.some((p) => p.includes('desktop'))).toBe(false);
    expect((r.output as { pages: Array<{ colorScheme: string }> }).pages.map((p) => p.colorScheme)).toEqual(['light', 'dark']);
    expect(r.evidence?.some((e) => e.startsWith('dark: '))).toBe(true);
    const plain = await call('verify.web', { url: base, paths: ['/other'] });
    expect(plain.ok, plain.summary).toBe(true);
    // Named as a person would list them (the App check and the task page read it).
    expect(plain.summary).toBe('Verified 1 page(s) at desktop and phone widths');
    const three = await call('verify.web', { url: base, paths: ['/other'], viewports: ['phone', 'tablet', 'desktop'], colorSchemes: ['light', 'dark'] });
    expect(three.summary).toBe('Verified 1 page(s) at phone, tablet and desktop widths in light and dark');
  }, 90_000);

  it('returns one contact sheet per colour scheme, with overflow and errors for every view', async () => {
    const r = await call('browser.visual_matrix', { url: `${base}/themed`, viewports: ['desktop', 'phone'], colorSchemes: ['light', 'dark'], settleMs: 0 });
    const cells = (r.output as { cells: Array<{ viewport: string; colorScheme: string; horizontalOverflow: boolean }> }).cells;
    // Widest last: phone first, then desktop, for each scheme.
    expect(cells.map((c) => `${c.viewport}/${c.colorScheme}`)).toEqual(['phone/light', 'desktop/light', 'phone/dark', 'desktop/dark']);
    expect(cells.filter((c) => c.horizontalOverflow).map((c) => `${c.viewport}/${c.colorScheme}`)).toEqual(['phone/light', 'phone/dark']);
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/page scrolls horizontally/);
    expect(r.images?.map((i) => [i.name, i.mime])).toEqual([['matrix-light.jpg', 'image/jpeg'], ['matrix-dark.jpg', 'image/jpeg']]);
    for (const image of r.images!) expect(image.data.length).toBeLessThanOrEqual(3 * 1024 * 1024);
  }, 90_000);
});

describe('browser.render_html (style tiles)', () => {
  let bait: http.Server;
  let baitBase: string;
  const hits: string[] = [];

  beforeAll(async () => {
    bait = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.setHeader('content-type', req.url?.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(req.url?.endsWith('.css') ? 'html { height: 9000px }' : '<p>reached</p>');
    });
    await new Promise<void>((r) => bait.listen(0, '127.0.0.1', r));
    baitBase = `http://127.0.0.1:${(bait.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => bait.close(() => r()));
  });

  it('loads data: pictures, runs no script and reaches nothing, naming every refused request', async () => {
    // Tall only when the data: picture loads (3000 px); taller than the cut (9000 px) if a script or the stylesheet ran.
    const tallSvg = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="3000"><rect width="10" height="3000" fill="#0a7a5a"/></svg>`);
    const html = `<!doctype html><html><head>
      <meta http-equiv="refresh" content="0;url=${baitBase}/refresh">
      <link rel="stylesheet" href="${baitBase}/sheet.css">
      <link rel="preconnect" href="${baitBase}"><link rel="prefetch" href="${baitBase}/prefetch">
      <style>@import url('${baitBase}/import.css'); @font-face { font-family: X; src: url('${baitBase}/font.woff2'); }
        body { margin: 0; font-family: X, system-ui; background: url('${baitBase}/bg.png'); } img { display: block; }</style>
      <script src="${baitBase}/script.js"></script>
      <script>document.documentElement.style.height = '9000px'; fetch('${baitBase}/fetch'); new Image().src = '${baitBase}/js-image';</script>
    </head><body><h1>Tile</h1><img alt="" src="data:image/svg+xml,${tallSvg}"><img alt="" src="${baitBase}/remote.png" width="10" height="10">
      <iframe src="${baitBase}/frame"></iframe><object data="${baitBase}/object"></object><video poster="${baitBase}/poster.jpg" src="${baitBase}/clip.mp4"></video></body></html>`;
    const r = await call('browser.render_html', { html, name: 'bold', viewport: 'desktop', colorSchemes: ['light', 'dark'] });
    expect(r.ok, r.summary).toBe(true);
    const out = r.output as { tiles: Array<{ colorScheme: string; width: number; height: number; clipped: boolean }>; refusedRequests: Array<{ url: string; type: string }> };
    expect(out.tiles.map((t) => [t.colorScheme, t.width, t.clipped])).toEqual([['light', 1280, false], ['dark', 1280, false]]);
    for (const tile of out.tiles) {
      expect(tile.height).toBeGreaterThanOrEqual(3000);
      expect(tile.height).toBeLessThan(4000);
    }
    // Nothing reached the network, and what the page asked for is named.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(hits).toEqual([]);
    const refused = out.refusedRequests.map((q) => q.url.replace(baitBase, ''));
    for (const url of ['/sheet.css', '/remote.png', '/frame']) expect(refused).toContain(url);
    expect(refused).not.toContain('/fetch');
    expect(refused).not.toContain('/js-image');
    expect(r.summary).toMatch(/outside request\(s\) refused \(127\.0\.0\.1:\d+\)/);
    expect(r.images?.map((i) => i.name)).toEqual(['tile-bold-light.png', 'tile-bold-dark.png']);
    expect(r.artifacts?.map((a) => a.name)).toEqual(['tile-bold-light.png', 'tile-bold-dark.png']);
  }, 90_000);

  it('runs no script in a sandboxed frame either, so nothing leaves over WebRTC', async () => {
    // A sandboxed frame is drawn in a process of its own, which the page's script switch reached only some of the time:
    // its script painted the frame magenta and sent STUN over UDP, which the sealed proxy never sees. It was a race, so a few rounds.
    const udp = dgram.createSocket('udp4');
    let packets = 0;
    udp.on('message', () => packets++);
    await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
    const script = `document.body.style.background = 'rgb(255, 0, 255)'; const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${udp.address().port}' }] }); pc.createDataChannel('x'); pc.createOffer().then((o) => pc.setLocalDescription(o));`;
    const frame = `<body style="margin:0;background:#fff"><script>${script}</script></body>`;
    const html = `<!doctype html><body style="margin:0">
      <iframe sandbox="allow-scripts" srcdoc="${frame.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" style="width:300px;height:200px;border:0"></iframe>
      <iframe sandbox="allow-scripts" src="data:text/html,${encodeURIComponent(frame)}" style="width:300px;height:200px;border:0"></iframe></body>`;
    try {
      const painted: string[] = [];
      for (let round = 1; round <= 3; round++) {
        const r = await call('browser.render_html', { html, name: 'frames', colorSchemes: ['light', 'dark'] });
        expect(r.ok, r.summary).toBe(true);
        expect(r.images).toHaveLength(2);
        for (const image of r.images!) if (magentaPixels(image.data)) painted.push(`${image.name}, round ${round}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect({ painted, packets }).toEqual({ painted: [], packets: 0 });
    } finally {
      udp.close();
    }
  }, 120_000);

  it('measures a page that sets html and body to the viewport height by what it scrolls', async () => {
    // The <html> box is then one viewport high while the content runs on below it.
    const page = (px: number) => `<!doctype html><style>html, body { height: 100%; margin: 0 }</style><body><div style="height:${px}px;background:#123456"></div></body>`;
    const r = await call('browser.render_html', { html: page(2500), colorSchemes: ['light'] });
    expect(r.ok, r.summary).toBe(true);
    expect((r.output as { tiles: unknown[] }).tiles).toEqual([expect.objectContaining({ width: 1280, height: 2500, clipped: false })]);
    expect(r.summary).not.toMatch(/cut at/);
    // The bottom of the tile is the page, not blank.
    const png = pngPixels(r.images![0]!.data);
    expect(png.height).toBe(2500);
    expect(png.at(10, 2499)).toEqual([0x12, 0x34, 0x56]);
    const cut = await call('browser.render_html', { html: page(6000), colorSchemes: ['light'] });
    expect((cut.output as { tiles: unknown[] }).tiles).toEqual([expect.objectContaining({ height: 4000, clipped: true })]);
    expect(cut.summary).toMatch(/cut at 4000 px/);
  }, 90_000);

  it('never draws a local file', async () => {
    // A 3000 px tall picture on disk: the tile stays short when it is not loaded.
    const { writeFileSync } = await import('node:fs');
    const file = path.join(temp, 'tall.svg');
    writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="3000"><rect width="10" height="3000"/></svg>');
    const r = await call('browser.render_html', { html: `<!doctype html><body style="margin:0"><img alt="" src="file://${file}"><iframe src="file://${file}"></iframe></body>`, colorSchemes: ['light'] });
    expect(r.ok, r.summary).toBe(true);
    expect((r.output as { tiles: Array<{ height: number }> }).tiles[0]!.height).toBeLessThan(3000);
  }, 90_000);

  it('cuts a tall page, and refuses HTML over the size limit', async () => {
    const r = await call('browser.render_html', { html: '<!doctype html><body style="margin:0"><div style="height:6000px;background:#123"></div></body>', colorSchemes: ['light'], viewport: 'phone' });
    expect(r.ok, r.summary).toBe(true);
    expect((r.output as { tiles: Array<{ width: number; height: number; clipped: boolean }> }).tiles).toEqual([expect.objectContaining({ width: 390, height: 4000, clipped: true })]);
    expect(r.summary).toMatch(/cut at 4000 px/);
    const op = registry.provider('playwright')!.operations.find((o) => o.id === 'browser.render_html')!;
    expect(op.input.safeParse({ html: 'x'.repeat(1_000_001) }).success).toBe(false);
    expect(op).toMatchObject({ level: 1, readOnly: true });
    expect(op.classify?.(op.input.parse({ html: '<p>x</p>' }), { cwd: temp })).toMatchObject({ effects: [] });
  }, 90_000);
});

describe('browser.visual_diff and browser.audit', () => {
  it('records a baseline (Level 2), then reports a match, then shows what moved', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-visual-'));
    const at = (update = false) => call('browser.visual_diff', { url: `${base}/diff`, name: 'box', viewport: 'phone', update }, { ...ctx(), cwd: dir, roots: [dir] });
    const op = registry.provider('playwright')!.operations.find((o) => o.id === 'browser.visual_diff')!;
    expect(op.classify!(op.input.parse({ url: `${base}/diff`, name: 'box', update: true }), { cwd: dir })).toMatchObject({ level: 2, writes: true });
    expect(op.classify!(op.input.parse({ url: `${base}/diff`, name: 'box' }), { cwd: dir })).toMatchObject({ writes: false });
    diffColour = '#2255dd';
    const none = await at();
    expect(none.ok).toBe(false);
    expect(none.summary).toMatch(/No baseline at visual-baselines\/box-phone-light.png/);
    const recorded = await at(true);
    expect(recorded.ok, recorded.summary).toBe(true);
    expect(recorded.filesChanged).toEqual(['visual-baselines/box-phone-light.png']);
    const same = await at();
    expect(same.output).toMatchObject({ matches: true, changedPercent: 0, sizeChanged: false });
    diffColour = '#dd2222';
    const moved = await at();
    const out = moved.output as { matches: boolean; changedPercent: number; changedPixels: number };
    expect(out.matches).toBe(false);
    // The 200×120 box changed colour: about 24 000 of the phone page's pixels.
    expect(out.changedPixels).toBeGreaterThan(20_000);
    expect(out.changedPercent).toBeGreaterThan(1);
    expect(moved.summary).toMatch(/differs from visual-baselines\/box-phone-light.png/);
    expect(moved.images?.[0]?.mime).toBe('image/png');
    diffColour = '#2255dd';
  }, 120_000);

  it('matches at threshold 0 only when no pixel changed', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'acc-visual-'));
    const at = (input: { update?: boolean; threshold?: number }) => call('browser.visual_diff', { url: `${base}/dot`, name: 'dot', viewport: 'phone', ...input }, { ...ctx(), cwd: dir, roots: [dir] });
    dotColour = '#2255dd';
    expect((await at({ update: true })).ok).toBe(true);
    expect((await at({ threshold: 0 })).output).toMatchObject({ matches: true, changedPixels: 0 });
    dotColour = '#dd2222';
    // Nine pixels of a 390 × 844 page: 0.003 %, shown rounded as 0 % but not nothing.
    const moved = await at({ threshold: 0 });
    expect(moved.output).toMatchObject({ matches: false, changedPixels: 9, changedPercent: 0 });
    expect(moved.summary).toMatch(/differs from visual-baselines\/dot-phone-light\.png: 9 pixel\(s\)/);
    // Within the default 0.1 %.
    expect((await at({})).output).toMatchObject({ matches: true, changedPixels: 9 });
    dotColour = '#2255dd';
  }, 120_000);

  it('measures LCP and CLS and names the images and videos that cost users', async () => {
    const r = await call('browser.audit', { url: `${base}/heavy`, viewport: 'phone', settleMs: 1500 });
    expect(r.ok, r.summary).toBe(true);
    const out = r.output as { metrics: { lcpMs: number | null; cls: number; totalBytes: number; bytesByType: Record<string, number> }; findings: Array<{ kind: string; detail: string }> };
    expect(out.metrics.lcpMs).not.toBeNull();
    // The late banner pushed the page down.
    expect(out.metrics.cls).toBeGreaterThan(0.1);
    expect(out.metrics.bytesByType.image).toBeGreaterThan(300_000);
    const kinds = new Set(out.findings.map((f) => f.kind));
    for (const kind of ['cls-high', 'heavy-image', 'image-no-dimensions', 'oversized-image', 'image-not-lazy', 'video-no-poster']) expect(kinds, kind).toContain(kind);
    expect(out.findings.find((f) => f.kind === 'image-no-dimensions')!.detail).toMatch(/big\.bmp/);
    expect(r.summary).toMatch(/LCP \d+ ms, CLS/);
  }, 90_000);
});
