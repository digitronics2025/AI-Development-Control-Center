import { connectedAppPairingSchema, connectedAppUpdateSchema } from '@acc/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '../app.js';
import { CONNECTED_APP_HTTP_STATUS, ConnectedAppError } from '../connected-apps/service.js';

/**
 * Connected apps (docs/systems/connected-apps.md).
 *
 *  - `/api/connected-apps/*` — the dashboard, with the local API token:
 *    pairing codes, the list, default mode, disconnect.
 *  - `/api/connected-app/*` — the paired app, with its own token only
 *    (security.ts lets these through without the local token and refuses any
 *    Origin). Pairing (guarded by its code) and hello (a signed identity
 *    statement, nothing else) are the only calls without a token.
 *
 * None of these are tools, MCP tools or remote operations, and a request the
 * cloud relayed (`x-acc-remote-request`) is refused on all of them.
 */

const idParam = z.object({ id: z.string().min(1).max(100) });
const TASK_BODY_LIMIT = 2 * 1024 * 1024;

function send(reply: FastifyReply, error: ConnectedAppError) {
  if (error.retryAfterSec) reply.header('retry-after', String(error.retryAfterSec));
  return reply
    .code(CONNECTED_APP_HTTP_STATUS[error.code])
    .header('cache-control', 'no-store')
    .send({ error: { code: error.code, message: error.message } });
}

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Local-only, and ConnectedAppError mapped to its status; anything else goes to the shared handler. */
function guarded(handler: Handler): Handler {
  return async (request, reply) => {
    if (request.headers['x-acc-remote-request']) return reply.code(403).send({ error: { code: 'REMOTE_FORBIDDEN', message: 'Connected apps are managed on this machine only.' } });
    try {
      return await handler(request, reply);
    } catch (error) {
      if (error instanceof ConnectedAppError) return send(reply, error);
      throw error;
    }
  };
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

export function registerConnectedAppRoutes(app: FastifyInstance, s: AppServices): void {
  const apps = s.connectedApps;

  // Dashboard (local API token).
  app.get('/api/connected-apps', guarded(async () => apps.status()));
  app.post(
    '/api/connected-apps/pairings',
    guarded(async (request, reply) => reply.code(201).send(await apps.createPairing(connectedAppPairingSchema.parse(request.body ?? {}).kind))),
  );
  app.delete(
    '/api/connected-apps/pairings',
    guarded(async (_request, reply) => {
      apps.cancelPairing();
      return reply.code(204).send();
    }),
  );
  app.get('/api/connected-apps/task-origins', guarded(async () => apps.taskOrigins()));
  app.patch('/api/connected-apps/:id', guarded(async (request) => apps.update(idParam.parse(request.params).id, connectedAppUpdateSchema.parse(request.body))));
  app.post('/api/connected-apps/:id/revoke', guarded(async (request) => apps.revoke(idParam.parse(request.params).id)));

  // The paired app (its own token).
  app.post('/api/connected-app/pair', { bodyLimit: 4 * 1024 }, guarded(async (request, reply) => reply.code(201).send(await apps.pair(request.body))));
  // No token: the app proves who answers before it sends its token (service.hello).
  app.post('/api/connected-app/hello', { bodyLimit: 4 * 1024 }, guarded(async (request) => apps.hello(request.body)));
  app.get('/api/connected-app/repositories', guarded(async (request) => {
    apps.authenticate(bearer(request));
    return apps.repositories();
  }));
  app.get('/api/connected-app/tasks', guarded(async (request) => apps.listTasks(apps.authenticate(bearer(request)))));
  app.post(
    '/api/connected-app/tasks',
    { bodyLimit: TASK_BODY_LIMIT },
    guarded(async (request, reply) => {
      const result = await apps.createTask(apps.authenticate(bearer(request)), request.body);
      return reply.code(result.created ? 201 : 200).send(result.task);
    }),
  );
  app.get('/api/connected-app/tasks/:id', guarded(async (request) => apps.getTask(apps.authenticate(bearer(request)), idParam.parse(request.params).id)));
  app.post(
    '/api/connected-app/tasks/:id/evidence',
    { bodyLimit: 256 * 1024 },
    guarded(async (request, reply) => {
      const result = await apps.addEvidence(apps.authenticate(bearer(request)), idParam.parse(request.params).id, request.body);
      return reply.code(result.created ? 201 : 200).send(result);
    }),
  );
}
