import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) return trimmed.slice(0, trimmed.indexOf(']') + 1);
  return trimmed.split(':')[0] ?? null;
}

/**
 * Origins allowed to call the API from a browser context: the orchestrator's
 * own pages, local dev servers, and VS Code WebViews. Everything else is
 * rejected before authentication is even considered.
 */
export function isAllowedOrigin(origin: string, extra: string[]): boolean {
  if (extra.includes(origin)) return true;
  if (origin.startsWith('vscode-webview://')) return true;
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname === '::1' ? '[::1]' : url.hostname);
  } catch {
    return false;
  }
}

export function tokensMatch(expected: string, provided: string | undefined | null): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function deny(request: FastifyRequest, reply: FastifyReply, status: number, code: string, message: string) {
  if (request.headers.upgrade) {
    // A refused WebSocket upgrade must not leave its raw socket open.
    reply.header('connection', 'close');
    reply.raw.once('finish', () => request.raw.socket?.destroy());
  }
  return reply.code(status).header('cache-control', 'no-store').send({ error: { code, message } });
}

/**
 * Local-service hardening (PLAN §30):
 *  - Host header must be a loopback name → defeats DNS rebinding.
 *  - Origin, when present, must be allow-listed → blocks other websites.
 *  - `/api` and `/ws` need the bearer token from the data directory.
 */
export function registerSecurity(app: FastifyInstance, options: { token: string; allowedOrigins: string[] }): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const host = hostnameOf(request.headers.host);
    if (!host || !LOCAL_HOSTNAMES.has(host)) {
      return deny(request, reply, 421, 'BAD_HOST', 'This service only answers requests addressed to localhost.');
    }
    const origin = request.headers.origin;
    if (origin && origin !== 'null' && !isAllowedOrigin(origin, options.allowedOrigins)) {
      return deny(request, reply, 403, 'BAD_ORIGIN', 'Origin not allowed.');
    }
    if (origin && isAllowedOrigin(origin, options.allowedOrigins)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'origin');
      reply.header('access-control-allow-headers', 'authorization, content-type');
      reply.header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      reply.header('access-control-max-age', '600');
    }
    const url = request.url;
    const isApi = url.startsWith('/api/') || url === '/api' || url.startsWith('/ws');
    if (!isApi) return;
    if (request.method === 'OPTIONS') return reply.code(204).send();
    // Tool sessions carry their own short-lived, scoped token; the route checks
    // it (and only it: the local API token does not open these routes).
    if (url.startsWith('/api/tool-session/')) return;
    const header = request.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
    // Browsers cannot set headers on a WebSocket handshake, so /ws also accepts ?token=.
    const queryToken = url.startsWith('/ws') ? new URL(url, 'http://localhost').searchParams.get('token') : null;
    if (!tokensMatch(options.token, bearer ?? queryToken)) {
      return deny(request, reply, 401, 'UNAUTHORIZED', 'Missing or invalid local API token.');
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    return payload;
  });
}
