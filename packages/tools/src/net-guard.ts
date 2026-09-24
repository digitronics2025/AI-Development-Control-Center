import { referencesSelf } from '@acc/security';
import type { BrowserContext } from 'playwright-core';

/**
 * Network guards shared by every tool that fetches or browses (audit F-31,
 * F-02): redirects are followed by hand so each hop is judged, the Control
 * Center's own address is never reached through a redirect or a page, and a
 * response is read up to a ceiling instead of whole into memory.
 */

/** The most bytes a tool reads from one response. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT = new Set([301, 302, 303, 307, 308]);

export class RedirectRefused extends Error {
  constructor(
    readonly location: string,
    reason: string,
  ) {
    super(reason);
  }
}

export interface GuardedResponse {
  res: Response;
  /** The URL that answered. */
  url: string;
  /** Set when a redirect to another origin was not followed (`crossOrigin: 'stop'`). */
  redirectedTo: string | null;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.startsWith('127.');
}

/**
 * `fetch` with redirects followed one hop at a time. A hop into the Control
 * Center itself, or from a remote site into this machine, is refused. With
 * `crossOrigin: 'stop'` (requests that change something) a redirect to another
 * origin is reported, not followed, so the new host is classified on its own.
 * A 303, or a 301/302 after anything but GET/HEAD, continues as a GET without
 * a body, as browsers do.
 */
export async function guardedFetch(url: string, init: RequestInit, opts: { crossOrigin: 'follow' | 'stop' }): Promise<GuardedResponse> {
  let current = new URL(url);
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  let headers = new Headers(init.headers);
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { ...init, method, body, headers, redirect: 'manual' });
    const location = res.headers.get('location');
    if (!REDIRECT.has(res.status) || !location) return { res, url: current.href, redirectedTo: null };
    await res.body?.cancel().catch(() => undefined);
    const next = new URL(location, current);
    if (!/^https?:$/.test(next.protocol)) throw new RedirectRefused(next.href, `Refused a redirect to a ${next.protocol} URL`);
    if (referencesSelf(next.href)) throw new RedirectRefused(next.href, "Refused a redirect into the Control Center's own address");
    if (!isLoopbackHost(current.hostname) && isLoopbackHost(next.hostname)) throw new RedirectRefused(next.href, 'Refused a redirect from a remote site to this machine');
    if (next.origin !== current.origin && opts.crossOrigin === 'stop') return { res, url: current.href, redirectedTo: next.href };
    if (hop >= MAX_REDIRECTS) throw new RedirectRefused(next.href, `More than ${MAX_REDIRECTS} redirects`);
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
      headers = new Headers(headers);
      headers.delete('content-type');
    }
    // Credentials never follow a request to another origin.
    if (next.origin !== current.origin) {
      headers = new Headers(headers);
      for (const h of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(h);
    }
    current = next;
  }
}

/** Read a response body up to `max` bytes. */
export async function readCapped(res: Response, max = MAX_RESPONSE_BYTES): Promise<{ buffer: Buffer; truncated: boolean }> {
  if (!res.body) return { buffer: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = max - total;
    if (value.byteLength > room) {
      if (room > 0) chunks.push(Buffer.from(value.subarray(0, room)));
      total = max;
      await reader.cancel().catch(() => undefined);
      return { buffer: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(Buffer.from(value));
    total += value.byteLength;
  }
  return { buffer: Buffer.concat(chunks), truncated: false };
}

/**
 * Pages a tool drives never load the Control Center itself: its dashboard
 * page carries the local token (audit F-02). Applied to every browser context
 * the tools create.
 */
export async function guardBrowserContext(context: BrowserContext): Promise<void> {
  await context.route((url) => referencesSelf(url.href), (route) => route.abort('blockedbyclient'));
}
