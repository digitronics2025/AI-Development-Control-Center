import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../app.js';
import { registerErrorHandler, registerRoutes } from './routes.js';
import { registerSecurity } from './security.js';
import { registerRemoteRoutes } from './remote-routes.js';
import { registerSourceControlRoutes } from './source-control-routes.js';
import { registerToolRoutes } from './tool-routes.js';
import { registerUsageRoutes } from './usage-routes.js';
import { registerLearningRoutes } from './learning-routes.js';
import { registerVaultBridgeRoutes } from './vault-bridge-routes.js';
import { registerConnectedAppRoutes } from './connected-app-routes.js';
import { registerAskRoutes } from './ask-routes.js';
import { registerWebSocket } from './ws.js';
import { LaunchTickets } from './launch-tickets.js';

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
  registerVaultBridgeRoutes(app, s);
  registerConnectedAppRoutes(app, s);
  registerUsageRoutes(app, s);
  registerLearningRoutes(app, s);
  registerAskRoutes(app, s);
  registerRemoteRoutes(app, s);
  // Remote commands run through these same routes, in process (docs/systems/remote-node.md).
  s.remote.attachHttp({ inject: (request) => app.inject({ ...request, method: request.method as 'GET' }) });

  // Liveness probe for launchers; reveals nothing about state.
  app.get('/healthz', async () => ({ ok: true }));

  // Launch tickets (docs/systems/security.md#agent-os-boundary): a launcher that holds the token asks for
  // one and opens `/?ticket=…`; with agent isolation on, only such a request gets the token in the page.
  // Never relayed from the cloud, which has no browser on this machine to open.
  const tickets = new LaunchTickets();
  app.post('/api/launch-tickets', async (request, reply) => {
    if (request.headers['x-acc-remote-request']) return reply.code(403).send({ error: { code: 'REMOTE_FORBIDDEN', message: 'Launch tickets are for launchers on this machine.' } });
    const issued = tickets.issue();
    return reply.code(201).header('cache-control', 'no-store').send({ ...issued, path: `/?ticket=${issued.ticket}` });
  });

  // Graceful stop for launchers: a background process on Windows cannot
  // receive Ctrl+C. Authenticated like every /api route. While stages run it
  // refuses unless asked to drain (stop each task at its next stage boundary,
  // resumed after the restart) or to force (interrupt them now, as before)
  // (docs/plans/AUTOPILOT_GATES_PLAN.md §3.G).
  app.post('/api/service/shutdown', async (request, reply) => {
    const onShutdown = options.onShutdownRequest;
    if (!onShutdown) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Shutdown is not available here' } });
    const { mode } = z.object({ mode: z.enum(['refuse', 'drain', 'force']).default('refuse') }).parse(request.body ?? {});
    const running = s.engine.runningStages();
    if (mode === 'force' || running.length === 0) {
      setImmediate(onShutdown);
      return reply.code(202).send({ ok: true, waitingFor: [] });
    }
    if (mode === 'refuse') {
      const list = running.map((r) => `${r.taskId}${r.stage ? ` (${r.stage})` : ''}`).join(', ');
      return reply.code(409).send({ error: { code: 'TASKS_RUNNING', message: `Not stopping: ${running.length} task${running.length === 1 ? ' is' : 's are'} running: ${list}. Drain to stop each at its next stage boundary, or force to interrupt them now.` }, running });
    }
    s.engine.drain(() => setImmediate(onShutdown));
    return reply.code(202).send({ ok: true, draining: true, waitingFor: running });
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
    const sendIndex = (request: FastifyRequest, reply: FastifyReply) => {
      // With agent isolation on, the page carries the token only for a launch ticket (single use, a minute):
      // agents run as another Windows account that cannot read the token file, and must not take it from here.
      if (s.settings.get().agentIsolation.mode === 'account') {
        const ticket = request.method === 'GET' ? (request.query as Record<string, unknown> | undefined)?.ticket : undefined;
        if (!tickets.consume(typeof ticket === 'string' ? ticket : null)) {
          return reply
            .code(403)
            .header('cache-control', 'no-store')
            .header('content-type', 'text/plain; charset=utf-8')
            .send('Open the AI Development Control Center from its launcher: the Start menu shortcut "AI Control Center", or scripts\\windows\\start-control-center.ps1. While agents run under their own Windows account, the dashboard opens only through a one-time link the launcher asks for, so reloading this page needs the launcher again.');
        }
      }
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
