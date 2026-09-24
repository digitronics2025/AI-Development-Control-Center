import { describe, expect, it, vi } from 'vitest';
import { probeCloudSession, SESSION_CHECK_INTERVAL_MS, SessionWatch } from './session';

function response(init: { status?: number; type?: ResponseType; contentType?: string }): Response {
  const status = init.status ?? 200;
  return { status, ok: status >= 200 && status < 300, type: init.type ?? 'basic', headers: new Headers(init.contentType ? { 'content-type': init.contentType } : {}) } as Response;
}

const fetchOf = (r: Response | Error) => (async () => (r instanceof Error ? Promise.reject(r) : r)) as unknown as typeof fetch;

describe('probeCloudSession', () => {
  it('reads an Access redirect, a 401 or a 403 as an expired sign-in', async () => {
    expect(await probeCloudSession(fetchOf(response({ status: 0, type: 'opaqueredirect' })))).toBe('expired');
    expect(await probeCloudSession(fetchOf(response({ status: 401, contentType: 'application/json' })))).toBe('expired');
    expect(await probeCloudSession(fetchOf(response({ status: 403, contentType: 'application/json' })))).toBe('expired');
  });

  it('reads a sign-in page served in place of the API as expired', async () => {
    expect(await probeCloudSession(fetchOf(response({ status: 200, contentType: 'text/html' })))).toBe('expired');
  });

  it('keeps a network fault and a healthy or busy control plane apart from expiry', async () => {
    expect(await probeCloudSession(fetchOf(new TypeError('Failed to fetch')))).toBe('ok');
    expect(await probeCloudSession(fetchOf(response({ status: 200, contentType: 'application/json; charset=utf-8' })))).toBe('ok');
    expect(await probeCloudSession(fetchOf(response({ status: 503, contentType: 'application/json' })))).toBe('ok');
  });

  it('asks without following redirects and without the cache', async () => {
    const fetchImpl = vi.fn(async () => response({ contentType: 'application/json' }));
    await probeCloudSession(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith('/api/cloud/session', { credentials: 'same-origin', redirect: 'manual', cache: 'no-store' });
  });
});

describe('SessionWatch', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('turns expired and tells listeners once', async () => {
    const watch = new SessionWatch(async () => 'expired');
    const listener = vi.fn();
    watch.subscribe(listener);
    watch.check();
    await flush();
    expect(watch.get()).toBe('expired');
    watch.check();
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('runs one check at a time and at most one per interval', async () => {
    let now = 0;
    const probe = vi.fn(async () => 'ok' as const);
    const watch = new SessionWatch(probe, () => now);
    watch.check();
    watch.check();
    await flush();
    watch.check();
    expect(probe).toHaveBeenCalledTimes(1);
    now = SESSION_CHECK_INTERVAL_MS;
    watch.check();
    await flush();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(watch.get()).toBe('ok');
  });

  it('treats a failing probe as no news', async () => {
    const watch = new SessionWatch(async () => Promise.reject(new Error('boom')));
    watch.check();
    await flush();
    expect(watch.get()).toBe('ok');
  });
});
