import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  budgetInputSchema,
  budgetUpdateSchema,
  pricingInputSchema,
  usageExportSchema,
  usageFilterSchema,
  usagePageSchema,
  usageTaskListSchema,
  type UsageFilter,
} from '@acc/shared';
import type { AppServices } from '../app.js';
import { BudgetError } from '../usage/budgets.js';
import { PricingError } from '../usage/pricing.js';

const MAX_RANGE_DAYS = 400;

export class UsageRequestError extends Error {}

/** A date range must be ordered and bounded, so every query stays within an indexed window. */
function checkRange<T extends UsageFilter>(filter: T): T {
  const from = Date.parse(filter.from);
  const to = Date.parse(filter.to);
  if (!(from < to)) throw new UsageRequestError('The start of the range must be before its end.');
  if (to - from > MAX_RANGE_DAYS * 86_400_000) throw new UsageRequestError(`Choose a range of at most ${MAX_RANGE_DAYS} days.`);
  return filter;
}

const idParam = z.object({ id: z.string().min(1).max(200) });
const breakdownParam = z.object({ dimension: z.enum(['provider', 'model', 'agent', 'role', 'project', 'taskType', 'effort']) });

/**
 * Usage, cost and capacity API (docs/systems/usage.md#api). Read-only views
 * over the ledger plus budgets, pricing and the repair operations. Behind
 * the same bearer token, Host and Origin checks as every other route.
 */
export function registerUsageRoutes(app: FastifyInstance, s: AppServices): void {
  const u = s.usage;
  const base = '/api/usage';
  const limits = { bodyLimit: 64 * 1024 };

  app.get(`${base}/overview`, async (request) => u.overview(checkRange(usageFilterSchema.parse(request.query))));
  app.get(`${base}/trend`, async (request) => u.trend(checkRange(usageFilterSchema.parse(request.query))));
  app.get(`${base}/breakdown/:dimension`, async (request) => {
    const { dimension } = breakdownParam.parse(request.params);
    return u.breakdown(checkRange(usageFilterSchema.parse(request.query)), dimension);
  });
  app.get(`${base}/tasks`, async (request) => {
    const q = checkRange(usageTaskListSchema.parse(request.query));
    return u.tasks(q, q.sort, q.offset, q.limit);
  });
  app.get(`${base}/tasks/:id`, async (request, reply) => {
    const ledger = u.taskLedger(idParam.parse(request.params).id);
    if (!ledger) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such task' } });
    return ledger;
  });
  app.get(`${base}/tasks/:id/live`, async (request) => u.live(idParam.parse(request.params).id));
  app.get(`${base}/providers`, async (request) => u.providers(checkRange(usageFilterSchema.parse(request.query))));
  app.get(`${base}/events`, async (request) => {
    const q = checkRange(usagePageSchema.parse(request.query));
    return u.events(q, q.cursor, q.limit);
  });
  app.get(`${base}/events/:id`, async (request, reply) => {
    const event = u.event(idParam.parse(request.params).id);
    if (!event) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'No such usage event' } });
    return event;
  });
  app.get(`${base}/anomalies`, async (request) => u.anomalyList(checkRange(usageFilterSchema.parse(request.query))));
  app.get(`${base}/health`, async () => u.health());
  app.post(`${base}/reconcile`, limits, async () => u.reconcile());
  app.post(`${base}/capacity/refresh`, limits, async () => u.refreshCapacity());

  app.get(`${base}/export`, async (request, reply) => {
    const q = checkRange(usageExportSchema.parse(request.query));
    const file = u.export(q, q.dataset, q.format);
    reply.header('content-type', file.contentType);
    reply.header('content-disposition', `attachment; filename="${file.filename}"`);
    reply.header('cache-control', 'no-store');
    return reply.send(file.body);
  });

  // ----- budgets -----------------------------------------------------------------

  app.get(`${base}/budgets`, async () => u.budgetStatuses());
  app.post(`${base}/budgets`, limits, async (request, reply) => {
    const budget = u.budgets.create(budgetInputSchema.parse(request.body));
    return reply.code(201).send(u.budgets.status(budget));
  });
  app.patch(`${base}/budgets/:id`, limits, async (request) => u.budgets.status(u.budgets.update(idParam.parse(request.params).id, budgetUpdateSchema.parse(request.body))));
  app.delete(`${base}/budgets/:id`, async (request, reply) => {
    u.budgets.delete(idParam.parse(request.params).id);
    return reply.code(204).send();
  });

  // ----- pricing ------------------------------------------------------------------

  app.get(`${base}/pricing`, async () => u.listPricing());
  app.post(`${base}/pricing`, limits, async (request, reply) => reply.code(201).send(u.addPricing(pricingInputSchema.parse(request.body))));
  app.post(`${base}/recalculate`, limits, async (request) => {
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300).default('Priced after a verified price was added') }).parse(request.body ?? {});
    return u.recalculate(reason);
  });
}

/** Domain errors of the usage API, for the shared error handler. */
export function usageErrorStatus(error: unknown): { status: number; code: string } | null {
  if (error instanceof UsageRequestError) return { status: 400, code: 'INVALID_RANGE' };
  if (error instanceof BudgetError) return { status: { NOT_FOUND: 404, DUPLICATE: 409, INVALID: 400 }[error.code], code: error.code };
  if (error instanceof PricingError) return { status: error.code === 'NOT_FOUND' ? 404 : 400, code: error.code };
  return null;
}
