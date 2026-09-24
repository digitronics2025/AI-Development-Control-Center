import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { askMessageBodySchema, askThreadCreateSchema, askThreadUpdateSchema } from '@acc/shared';
import type { AppServices } from '../app.js';

const idParam = z.object({ id: z.string().min(1).max(100) });

/** Ask: read-only conversations outside tasks (docs/systems/ask.md). Local only; not in the remote catalog. */
export function registerAskRoutes(app: FastifyInstance, s: AppServices): void {
  app.get('/api/ask/threads', async () => s.ask.list());

  /** Which data sources are set up (names and reasons only). */
  app.get('/api/ask/sources', async () => s.ask.sources());

  /** One real read per source through a read-only session (Settings → Ask → Check access). */
  app.post('/api/ask/sources/check', async () => s.ask.checkSources());

  app.post('/api/ask/threads', async (request, reply) => reply.code(201).send(s.ask.create(askThreadCreateSchema.parse(request.body ?? {}))));

  app.get('/api/ask/threads/:id', async (request) => s.ask.detail(idParam.parse(request.params).id));

  app.patch('/api/ask/threads/:id', async (request) => s.ask.update(idParam.parse(request.params).id, askThreadUpdateSchema.parse(request.body ?? {})));

  app.delete('/api/ask/threads/:id', async (request, reply) => {
    await s.ask.remove(idParam.parse(request.params).id);
    return reply.code(204).send();
  });

  app.post('/api/ask/threads/:id/messages', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = askMessageBodySchema.parse(request.body);
    const { message, duplicate } = s.ask.post(id, body.text, body.clientMessageId);
    return reply.code(duplicate ? 200 : 202).send(message);
  });

  app.post('/api/ask/threads/:id/cancel', async (request) => {
    const { id } = idParam.parse(request.params);
    await s.ask.cancel(id);
    return s.ask.detail(id);
  });
}
