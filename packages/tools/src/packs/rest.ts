import { readCapped } from '../net-guard.js';
import type { OperationContext } from '../sdk.js';

/**
 * JSON over HTTPS for the read-only data packs (docs/systems/ask.md). One
 * retry on 429 or 5xx, honouring `retry-after` up to 5 s; bodies are read up
 * to a byte cap; redirects are refused (a token is never re-sent to another
 * host). A base URL may be overridden only with a loopback address, so tests
 * can stand in for the real API while a real token can never be pointed
 * anywhere else.
 */

export interface RestResponse {
  ok: boolean;
  status: number;
  /** Parsed JSON, or null when the body was not JSON. */
  json: any;
  /** Raw body text (capped). */
  text: string;
  truncated: boolean;
  headers: Headers;
}

const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/.*)?$/;

/** The API base: the real one, or a loopback override from `ctx.env[overrideVar]` (tests). */
export function apiBase(ctx: Pick<OperationContext, 'env'>, real: string, overrideVar: string): string {
  const override = ctx.env[overrideVar];
  return override && LOOPBACK.test(override) ? override.replace(/\/$/, '') : real;
}

export async function restRequest(
  ctx: Pick<OperationContext, 'signal'>,
  url: string,
  init: { method?: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown; maxBytes?: number; timeoutMs?: number },
): Promise<RestResponse> {
  const attempt = async (): Promise<RestResponse> => {
    const res = await fetch(url, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: 'manual',
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(init.timeoutMs ?? 30_000)]),
    });
    const { buffer, truncated } = await readCapped(res, init.maxBytes ?? 4 * 1024 * 1024);
    const text = buffer.toString('utf8');
    let json: any;
    try {
      json = truncated ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text, truncated, headers: res.headers };
  };
  const first = await attempt();
  if (first.status !== 429 && first.status < 500) return first;
  const wait = Math.min(5, Number(first.headers.get('retry-after')) || 1) * 1000;
  await new Promise((resolve) => setTimeout(resolve, wait));
  return attempt();
}

/** Names used in URL paths: never raw input, never a path separator. */
export function pathSegment(value: string): string {
  return encodeURIComponent(value);
}
