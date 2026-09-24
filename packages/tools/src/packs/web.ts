import { redact } from '@acc/security';
import { z } from 'zod';
import { guardedFetch, readCapped, RedirectRefused } from '../net-guard.js';
import { failure, operation, type OperationResult, type ToolProvider } from '../sdk.js';
import { httpUrl, isLoopback } from './browser.js';

/**
 * The web for research: search it and read pages as text. No API key and no
 * paid service — search asks DuckDuckGo's plain-HTML page, the one it serves
 * to browsers without JavaScript. Reading prefers the Playwright provider
 * (`web.read` in browser-session.ts renders script-built pages); this
 * provider's `web.read` is the fetch-only fallback when no browser exists.
 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const SEARCH_URL = 'https://html.duckduckgo.com/html/';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (ENTITIES[name] !== undefined) return ENTITIES[name]!;
    if (/^#x/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (/^#\d/.test(name)) return String.fromCodePoint(Number(name.slice(1)));
    return whole;
  });
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** DuckDuckGo sometimes links through its own redirect; return the real target. */
function unwrap(href: string): string {
  const url = decodeEntities(href);
  const m = /[?&]uddg=([^&]+)/.exec(url);
  if (m) return decodeURIComponent(m[1]!);
  return url.startsWith('//') ? `https:${url}` : url;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** Results from DuckDuckGo's HTML page, adverts left out. */
export function parseSearchResults(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/<div class="result results_links/).slice(1);
  for (const block of blocks) {
    if (/result--ad/.test(block.slice(0, 200))) continue;
    const link = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/.exec(block);
    const url = unwrap(link[1]!);
    if (!/^https?:\/\//i.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    hits.push({ title: stripTags(link[2]!), url, snippet: snippet ? stripTags(snippet[1]!) : '' });
  }
  return hits;
}

/** Readable text of an HTML document without a browser: scripts, styles and markup removed. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  const main = /<main[\s>][\s\S]*?<\/main>/i.exec(html)?.[0] ?? /<article[\s>][\s\S]*?<\/article>/i.exec(html)?.[0] ?? /<body[\s>][\s\S]*<\/body>/i.exec(html)?.[0] ?? html;
  const text = decodeEntities(
    main
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(?:br|hr)\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr|pre|blockquote|header|footer|nav)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

async function search(input: { query: string; max: number; site?: string; region: string; timeoutSec: number }, signal: AbortSignal): Promise<OperationResult> {
  const q = input.site ? `${input.query} site:${input.site}` : input.query;
  let res: Response;
  try {
    res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'user-agent': USER_AGENT, 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: new URLSearchParams({ q, kl: input.region }).toString(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(input.timeoutSec * 1000)]),
    });
  } catch (error) {
    return failure('UNAVAILABLE', `Search could not reach DuckDuckGo: ${(error as Error & { cause?: Error }).cause?.message ?? (error as Error).message}`);
  }
  const html = (await readCapped(res, 4 * 1024 * 1024)).buffer.toString('utf8');
  if (!res.ok) return failure('UNAVAILABLE', `DuckDuckGo answered HTTP ${res.status}; try again in a minute`);
  const hits = parseSearchResults(html).slice(0, input.max);
  if (!hits.length) {
    if (/anomaly|captcha|challenge/i.test(html) && !/class="result__a"/.test(html)) return failure('UNAVAILABLE', 'DuckDuckGo asked for a human check; searching is paused for a while — read a known URL with web.read instead');
    return { ok: true, summary: `No results for "${redact(input.query)}"`, output: { query: redact(q), results: [] }, networkTargets: ['html.duckduckgo.com'] };
  }
  const results = hits.map((h) => ({ title: redact(h.title), url: redact(h.url), snippet: redact(h.snippet) }));
  return {
    ok: true,
    summary: `${results.length} result(s) for "${redact(input.query)}"`,
    stdout: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n'),
    output: { query: redact(q), count: results.length },
    networkTargets: ['html.duckduckgo.com'],
  };
}

export function webProvider(): ToolProvider {
  return {
    id: 'web',
    name: 'Web (built-in)',
    description: 'Web search (DuckDuckGo, no key) and reading pages as text without a browser.',
    category: 'http',
    // The Playwright provider reads pages better (it runs their scripts); this is the fallback.
    preference: 60,
    async detect() {
      return { installed: typeof fetch === 'function', version: process.versions.node, path: null, auth: { required: false, state: 'not_required', message: null }, message: `Node ${process.versions.node}` };
    },
    operations: [
      operation({
        id: 'web.search',
        title: 'Search the web',
        description: 'Search the web and get titles, links and snippets — for error messages, library documentation, release notes, how others solved a problem. Then read a result with web.read. `site` limits results to one site (e.g. "developers.cloudflare.com").',
        input: z.object({
          query: z.string().min(2).max(400),
          max: z.number().int().min(1).max(20).default(8),
          site: z
            .string()
            .max(200)
            .regex(/^[a-z0-9.-]+\.[a-z]{2,}(?:\/[\w./-]*)?$/i, 'A site such as "developer.mozilla.org"')
            .optional(),
          region: z.string().regex(/^[a-z]{2}-[a-z]{2}$|^wt-wt$/).default('wt-wt'),
          timeoutSec: z.number().int().min(3).max(60).default(20),
        }),
        level: 1,
        classify: () => ({ effects: ['network'], reasons: ['Sends the query to DuckDuckGo'] }),
        run: (input, ctx) => search(input, ctx.signal),
      }),
      operation({
        id: 'web.read',
        title: 'Read a web page',
        description: 'Fetch a URL and return its readable text (no browser: pages built by scripts may come back empty).',
        input: z.object({ url: httpUrl, maxChars: z.number().int().min(500).max(60_000).default(20_000), links: z.boolean().default(true), timeoutSec: z.number().int().min(5).max(90).default(30) }),
        level: 1,
        classify: (input) => ({ effects: isLoopback(input.url) ? [] : ['network'] }),
        async run(input, ctx) {
          let res: Response;
          let answeredBy: string;
          try {
            // Each redirect hop is judged: never into the Control Center or from the internet into this machine (audit F-31).
            ({ res, url: answeredBy } = await guardedFetch(input.url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' }, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(input.timeoutSec * 1000)]) }, { crossOrigin: 'follow' }));
          } catch (error) {
            if (error instanceof RedirectRefused) return failure('DENIED', `${redact(input.url)}: ${error.message}`);
            return failure('FAILED', `Could not fetch ${redact(input.url)}: ${(error as Error & { cause?: Error }).cause?.message ?? (error as Error).message}`);
          }
          const type = res.headers.get('content-type') ?? '';
          const raw = (await readCapped(res, 8 * 1024 * 1024)).buffer.toString('utf8');
          const { title, text } = /html|xml/i.test(type) ? htmlToText(raw) : { title: '', text: raw.trim() };
          const clean = redact(text);
          const body = clean.length > input.maxChars ? `${clean.slice(0, input.maxChars)}\n… (cut at ${input.maxChars} of ${clean.length} characters; raise maxChars to read more)` : clean;
          const links = input.links && /html/i.test(type) ? [...raw.matchAll(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: decodeEntities(m[1]!), text: stripTags(m[2]!).slice(0, 120) })).filter((l, i, all) => l.text && all.findIndex((o) => o.href === l.href) === i).slice(0, 60) : [];
          const finalUrl = redact(answeredBy || input.url);
          return {
            ok: res.ok,
            summary: `${res.ok ? 'Read' : `HTTP ${res.status} from`} ${finalUrl}${title ? ` — ${redact(title)}` : ''} (${clean.length} characters)`,
            stdout: `# ${redact(title) || finalUrl}\n${finalUrl}\n\n${body}${links.length ? `\n\nLinks:\n${links.map((l) => `- ${redact(l.text)}: ${redact(l.href)}`).join('\n')}` : ''}`,
            output: { url: finalUrl, status: res.status, title: redact(title), characters: clean.length },
            networkTargets: [new URL(input.url).host],
            ...(res.ok ? {} : { error: { code: 'FAILED' as const, message: `HTTP ${res.status}` } }),
          };
        },
      }),
    ],
  };
}
