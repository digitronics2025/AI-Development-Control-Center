import type { FastifyInstance } from 'fastify';
import { learningTaskParamSchema, reviewTrigger } from '@acc/shared';
import type { AppServices } from '../app.js';

/**
 * Learning loop API (docs/systems/learning.md#api). Behind the same bearer
 * token, Host and Origin checks as every other route. Local only: the
 * cloud relay never forwards these, and the `learning` WebSocket message is
 * not relayed either.
 */
export function registerLearningRoutes(app: FastifyInstance, s: AppServices): void {
  const notFound = { error: { code: 'NOT_FOUND', message: 'Not found' } };

  app.get('/api/learning', async () => s.learning.overview());

  app.get('/api/learning/tasks/:id', async (request, reply) => {
    const { id } = learningTaskParamSchema.parse(request.params);
    if (!s.store.getTask(id)) return reply.code(404).send(notFound);
    return s.learning.taskView(id);
  });

  /** Review a completed or stuck task again (for example after changing the Chairman agent). */
  app.post('/api/learning/tasks/:id/review', async (request, reply) => {
    const { id } = learningTaskParamSchema.parse(request.params);
    const task = s.store.getTask(id);
    if (!task) return reply.code(404).send(notFound);
    if (!reviewTrigger(task)) return reply.code(409).send({ error: { code: 'INVALID_STATE', message: 'Only completed or stuck tasks are reviewed.' } });
    return reply.code(202).send(s.learning.enqueue(id, true));
  });

  app.post('/api/learning/improvements/:id/revert', async (request, reply) => {
    const { id } = learningTaskParamSchema.parse(request.params);
    const current = s.learning.store.improvement(id);
    if (!current) return reply.code(404).send(notFound);
    if (!['trial', 'active'].includes(current.status)) return reply.code(409).send({ error: { code: 'INVALID_STATE', message: 'This improvement is not live.' } });
    return s.learning.undo(id, 'user', 'Undone by you.');
  });

  app.post('/api/learning/findings/:id/dismiss', async (request, reply) => {
    const { id } = learningTaskParamSchema.parse(request.params);
    const current = s.learning.store.finding(id);
    if (!current) return reply.code(404).send(notFound);
    if (current.status === 'adopted') return reply.code(409).send({ error: { code: 'INVALID_STATE', message: 'Undo the improvement instead.' } });
    return s.learning.dismiss(id);
  });

  /** "Do it now": carry out a finding's proposal at the operator's request. */
  app.post('/api/learning/findings/:id/act', async (request, reply) => {
    const { id } = learningTaskParamSchema.parse(request.params);
    const current = s.learning.store.finding(id);
    if (!current) return reply.code(404).send(notFound);
    if (!current.proposal) return reply.code(409).send({ error: { code: 'INVALID_STATE', message: 'This finding has nothing the Chairman can carry out.' } });
    if (current.status === 'adopted') return reply.code(409).send({ error: { code: 'INVALID_STATE', message: 'Already acted on.' } });
    const result = await s.learning.actNow(id);
    if (!result.improvement) return reply.code(409).send({ error: { code: 'NOT_ADOPTED', message: result.finding?.statusReason ?? 'The Chairman could not carry it out.' }, finding: result.finding });
    return result;
  });
}
