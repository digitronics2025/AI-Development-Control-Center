import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppServices } from '../app.js';
import { registerErrorHandler, registerRoutes } from './routes.js';
import { registerSecurity } from './security.js';
import { registerSourceControlRoutes } from './source-control-routes.js';
import { registerToolRoutes } from './tool-routes.js';
import { registerUsageRoutes } from './usage-routes.js';
import { registerWebSocket } from './ws.js';

const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export async function buildServer(
  s: AppServices,
  options: { logger?: boolean; onShutdownRequest?: () => void } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger
      ? {
          level: process.env.ACC_LOG_LEVEL ?? 'info',
          redact: ['req.headers.authorization'],
          serializers: {
            // Never log the WebSocket token query parameter.
            req: (req) => ({ method: req.method, url: req.url?.replace(/token=[^&]+/, 'token=[REDACTED]') }),
          },
        }
      : false,
    bodyLimit: 20 * 1024 * 1024,
    // Shutdown must not wait on idle keep-alive or half-open client connections.
    forceCloseConnections: true,
  });

  registerSecurity(app, { token: s.config.token, allowedOrigins: s.config.allowedOrigins });
  registerErrorHandler(app);
  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });
  registerWebSocket(app, s);
  registerRoutes(app, s);
  registerSourceControlRoutes(app, s);
  registerToolRoutes(app, s);
  registerUsageRoutes(app, s);

  // Liveness probe for launchers; reveals nothing about state.
  app.get('/healthz', async () => ({ ok: true }));

  // Graceful stop for launchers: a background process on Windows cannot
  // receive Ctrl+C. Authenticated like every /api route; running work is
  // marked INTERRUPTED so it can be resumed after the next start.
  app.post('/api/service/shutdown', async (_request, reply) => {
    if (!options.onShutdownRequest) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Shutdown is not available here' } });
    setImmediate(options.onShutdownRequest);
    return reply.code(202).send({ ok: true });
  });

  const dashboardDir = s.config.dashboardDir;
  if (dashboardDir && existsSync(path.join(dashboardDir, 'index.html'))) {
    const indexPath = path.join(dashboardDir, 'index.html');
    // Re-read whenever the file changes: a dashboard rebuild while the
    // orchestrator runs replaces the hashed entry chunk, and a stale copy
    // would point the browser at a script that no longer exists.
    let cached: { mtimeMs: number; html: string } | null = null;
    const indexHtml = (): string | null => {
      try {
        const { mtimeMs } = statSync(indexPath);
        if (cached?.mtimeMs !== mtimeMs) {
          // The token reaches the dashboard only through its own same-origin
          // HTML, which other websites cannot read.
          const html = readFileSync(indexPath, 'utf8').replace('</head>', `<meta name="acc-token" content="${escapeAttr(s.config.token)}"></head>`);
          cached = { mtimeMs, html };
        }
        return cached.html;
      } catch {
        return null; // mid-rebuild: the build tool emptied the folder
      }
    };
    const sendIndex = (_req: unknown, reply: import('fastify').FastifyReply) => {
      const html = indexHtml();
      if (html === null) {
        return reply
          .code(503)
          .header('retry-after', '2')
          .header('content-type', 'text/plain; charset=utf-8')
          .send('The dashboard is being rebuilt. Reload in a moment.');
      }
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('content-security-policy', DASHBOARD_CSP)
        .header('x-frame-options', 'DENY')
        .send(html);
    };
    await app.register(fastifyStatic, {
      root: dashboardDir,
      index: false,
      // Look files up per request rather than listing them once at start, so
      // assets from a rebuild are served without a restart.
      wildcard: true,
      setHeaders: (res, file) => {
        if (file.includes(`${path.sep}assets${path.sep}`)) res.header('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    app.get('/', sendIndex);
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api') && !request.url.startsWith('/ws') && !path.extname(request.url.split('?')[0]!)) {
        return sendIndex(request, reply);
      }
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .header('content-type', 'text/plain; charset=utf-8')
        .send('AI Development Control Center orchestrator is running. The dashboard is not built yet: run `pnpm build`.'),
    );
  }

  return app;
}
