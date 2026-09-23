import type { Env } from './env.js';
import { errorResponse, HttpError, json, log, withSecurityHeaders } from './http.js';
import { handleControl } from './routes/control.js';
import { handleRelay } from './routes/relay.js';
import { CloudStore } from './store.js';

export { WorkspaceHub } from './hub.js';

/**
 * Cloud control plane entry (docs/systems/cloud-control.md). Two hostnames,
 * two trust boundaries, one Worker: the control host serves people behind
 * Cloudflare Access; the relay host serves execution nodes with their own
 * cryptographic sessions. A request for the wrong kind of path on either host
 * is refused, and an unknown host (workers.dev, a preview) gets nothing.
 */

const hosts = (value: string) =>
  value
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = request.headers.get('cf-ray') ?? crypto.randomUUID();
    const url = new URL(request.url);
    const host = url.hostname.toLowerCase();
    const isRelayPath = url.pathname.startsWith('/node/v1/');
    const control = hosts(env.CONTROL_HOSTS).includes(host);
    const relay = hosts(env.RELAY_HOSTS).includes(host);
    try {
      // Liveness only; reveals nothing.
      if (url.pathname === '/health' && request.method === 'GET') return withSecurityHeaders(json({ ok: true }), requestId);
      let response: Response;
      if (isRelayPath && relay) response = await handleRelay(request, env, requestId);
      else if (!isRelayPath && control) response = await handleControl(request, env, requestId);
      else throw new HttpError(404, 'NOT_FOUND', 'Not found');
      // WebSocket upgrades pass through untouched.
      return response.status === 101 ? response : withSecurityHeaders(response, requestId);
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status >= 500) log('warn', 'request.refused', { requestId, path: url.pathname, code: error.code });
        const response = errorResponse(error);
        // Unauthenticated WebSocket upgrades are closed, not left open.
        if (request.headers.get('upgrade')) response.headers.set('connection', 'close');
        return withSecurityHeaders(response, requestId);
      }
      log('error', 'request.failed', { requestId, path: url.pathname, message: (error as Error).message });
      return withSecurityHeaders(errorResponse(new HttpError(500, 'INTERNAL', 'Internal error. The request id is in the response headers.')), requestId);
    }
  },

  /** Daily retention: cloud copies only; nodes keep their own history. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const { r2Keys } = await new CloudStore(env.DB).prune();
    for (let i = 0; i < r2Keys.length; i += 1000) await env.ARTIFACTS.delete(r2Keys.slice(i, i + 1000));
    log('info', 'retention.pruned', { objects: r2Keys.length });
  },
} satisfies ExportedHandler<Env>;
