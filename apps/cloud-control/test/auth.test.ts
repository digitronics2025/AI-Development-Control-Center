import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startCloud, type Cloud } from './harness.js';

let cloud: Cloud;
beforeAll(async () => {
  cloud = await startCloud({ vars: { ALLOWED_EMAILS: 'operator@example.com,second@example.com' } });
});
afterAll(async () => {
  await cloud?.stop();
});

async function raw(pathname: string, headers: Record<string, string> = {}, method = 'GET'): Promise<number> {
  return (await fetch(`${cloud.url}${pathname}`, { method, headers })).status;
}

/** Plain HTTP with a chosen Host header (fetch forbids setting it). */
function viaHost(host: string, pathname: string, method = 'GET', headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: cloud.port, path: pathname, method, headers: { host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

function wsStatus(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${cloud.url.replace('http', 'ws')}/ws`, { headers });
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve(0));
  });
}

describe('people: Cloudflare Access on the control host', () => {
  it('answers liveness without revealing anything', async () => {
    const r = await fetch(`${cloud.url}/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('refuses API, dashboard assets and realtime without a valid token', async () => {
    expect(await raw('/api/cloud/session')).toBe(401);
    expect(await raw('/')).toBe(401);
    expect(await raw('/assets/does-not-matter.js')).toBe(401);
    expect(await raw('/api/tasks')).toBe(401);
    expect(await wsStatus({ origin: cloud.url })).toBe(401);
  });

  it('refuses forged, expired, wrong-audience, wrong-issuer and unknown-key tokens', async () => {
    const s = cloud.signer;
    const cases = {
      forged: await s.token({}, { key: s.otherKey }),
      expired: await s.token({ exp: Math.floor(Date.now() / 1000) - 3600 }),
      audience: await s.token({ aud: ['someone-else'] }),
      issuer: await s.token({ iss: 'https://evil.cloudflareaccess.com' }),
      unknownKey: await s.token({}, { kid: 'nope' }),
      notAllowed: await s.token({ email: 'intruder@example.com' }),
      noEmail: await s.token({ email: undefined }),
    };
    for (const [name, token] of Object.entries(cases)) {
      const status = await raw('/api/cloud/session', { 'cf-access-jwt-assertion': token });
      expect(status, name).toBe(name === 'notAllowed' || name === 'noEmail' ? 403 : 401);
    }
    expect(await raw('/api/cloud/session', { 'cf-access-jwt-assertion': 'not.a.jwt' })).toBe(401);
    // A malformed cookie is no sign-in, not a server error.
    expect(await raw('/api/cloud/session', { cookie: 'CF_Authorization=%E0%A4%A' })).toBe(401);
    expect(await wsStatus({ origin: cloud.url, 'cf-access-jwt-assertion': cases.forged })).toBe(401);
  });

  it('accepts a valid token from the header or the CF_Authorization cookie', async () => {
    const token = await cloud.signer.token();
    const session = await cloud.api('GET', '/api/cloud/session');
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ user: { email: 'operator@example.com' }, nodes: [] });
    expect(await raw('/api/cloud/session', { cookie: `CF_Authorization=${token}` })).toBe(200);
    // The dashboard itself, with its CSP.
    const page = await fetch(`${cloud.url}/tasks`, { headers: { cookie: `CF_Authorization=${token}` } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toBe(
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
      ].join('; '),
    );
    const html = await page.text();
    expect(html).toContain('<div id="root">');
    expect(html).not.toContain('acc-token');
    expect(await wsStatus({ origin: cloud.url, cookie: `CF_Authorization=${token}` })).toBe(101);
  });

  it('refuses cross-origin writes and cross-site realtime', async () => {
    const token = await cloud.signer.token();
    expect(await raw('/api/cloud/pairing-tokens', { 'cf-access-jwt-assertion': token, origin: 'https://evil.example', 'content-type': 'application/json' }, 'POST')).toBe(403);
    expect(await wsStatus({ origin: 'https://evil.example', 'cf-access-jwt-assertion': token })).toBe(403);
  });

  it('keeps the two hostnames apart', async () => {
    const token = await cloud.signer.token();
    // The relay host never serves the dashboard or the human API, even with a valid Access token.
    expect((await viaHost('relay.test', '/', 'GET', { 'cf-access-jwt-assertion': token })).status).toBe(404);
    expect((await viaHost('relay.test', '/api/cloud/session', 'GET', { 'cf-access-jwt-assertion': token })).status).toBe(404);
    // The control host never serves node routes.
    expect((await viaHost('control.test', '/node/v1/challenge', 'POST', { 'content-type': 'application/json' })).status).toBe(404);
    // An unknown host (workers.dev, a preview) gets nothing.
    expect((await viaHost('acc.workers.dev', '/', 'GET', { 'cf-access-jwt-assertion': token })).status).toBe(404);
    expect((await viaHost('relay.test', '/node/v1/challenge', 'POST', { 'content-type': 'application/json' })).status).toBe(400);
  });
});

describe('fail closed without Access', () => {
  it('serves nothing to people when no team domain or audience is configured', async () => {
    const bare = await startCloud({ vars: { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' } });
    try {
      const token = await bare.signer.token();
      for (const p of ['/', '/api/cloud/session', '/api/tasks']) {
        const r = await fetch(`${bare.url}${p}`, { headers: { 'cf-access-jwt-assertion': token } });
        expect(r.status, p).toBe(503);
        expect(((await r.json()) as { error: { code: string } }).error.code).toBe('ACCESS_NOT_CONFIGURED');
      }
    } finally {
      await bare.stop();
    }
  });
});
