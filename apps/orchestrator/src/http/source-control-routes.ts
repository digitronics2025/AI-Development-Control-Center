import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  commitDiffQuerySchema,
  commitRequestSchema,
  diffQuerySchema,
  fetchRequestSchema,
  historyQuerySchema,
  publishRequestSchema,
  reviewStagedRequestSchema,
  shaSchema,
  stageRequestSchema,
  suggestMessageRequestSchema,
  syncRequestSchema,
  unstageRequestSchema,
} from '@acc/shared';
import type { AppServices } from '../app.js';

const repoParam = z.object({ id: z.string().min(1).max(200) });

/**
 * Source Control API (docs/systems/source-control.md). Repository-centric,
 * typed actions only: there is no endpoint that runs arbitrary Git
 * arguments, and every path must be one Git currently reports as changed.
 */
export function registerSourceControlRoutes(app: FastifyInstance, s: AppServices): void {
  const sc = s.sourceControl;
  const base = '/api/repositories/:id/source-control';
  const id = (request: { params: unknown }) => repoParam.parse(request.params).id;
  // Source Control requests are small; a commit message is the largest field.
  const limits = { bodyLimit: 1024 * 1024 };

  // ----- reads ------------------------------------------------------------------

  app.get(base, async (request) => sc.snapshot(id(request)));

  app.post(`${base}/refresh`, limits, async (request) => sc.snapshot(id(request), { fresh: true }));

  app.get(`${base}/diff`, async (request) => {
    const q = diffQuerySchema.parse(request.query);
    return sc.diff(id(request), q.path, q.mode);
  });

  app.get(`${base}/history`, async (request) => {
    const q = historyQuerySchema.parse(request.query);
    return sc.history(id(request), { cursor: q.cursor, limit: q.limit });
  });

  app.get(`${base}/commits/:sha`, async (request) => {
    const { sha } = z.object({ id: z.string(), sha: shaSchema }).parse(request.params);
    return sc.commit(id(request), sha);
  });

  app.get(`${base}/commits/:sha/diff`, async (request) => {
    const { sha } = z.object({ id: z.string(), sha: shaSchema }).parse(request.params);
    return sc.commitDiff(id(request), sha, commitDiffQuerySchema.parse(request.query).path);
  });

  app.get(`${base}/operations`, async (request) => sc.operations(id(request)));

  app.get(`${base}/review`, async (request) => (await s.sourceControlAssist.latestReview(id(request))) ?? { task: null, review: null, verdict: null });

  // ----- mutations ------------------------------------------------------------------

  app.post(`${base}/stage`, limits, async (request) => {
    const body = stageRequestSchema.parse(request.body);
    return sc.stage(id(request), 'all' in body ? { ...body, all: true } : body);
  });

  app.post(`${base}/unstage`, limits, async (request) => {
    const body = unstageRequestSchema.parse(request.body);
    return sc.unstage(id(request), 'all' in body ? { ...body, all: true } : body);
  });

  app.post(`${base}/commit`, limits, async (request) => sc.commitStaged(id(request), commitRequestSchema.parse(request.body)));

  app.post(`${base}/fetch`, limits, async (request) => sc.fetch(id(request), fetchRequestSchema.parse(request.body ?? {})));

  app.post(`${base}/sync`, limits, async (request) => sc.sync(id(request), syncRequestSchema.parse(request.body)));

  app.post(`${base}/publish`, limits, async (request) => sc.publish(id(request), publishRequestSchema.parse(request.body)));

  // ----- AI assistance (optional; Git never depends on it) -----------------------------

  app.post(`${base}/suggest-message`, limits, async (request) => {
    const body = suggestMessageRequestSchema.parse(request.body);
    return s.sourceControlAssist.suggestMessage(id(request), body.expectedVersion);
  });

  app.post(`${base}/review-staged`, limits, async (request, reply) => {
    const body = reviewStagedRequestSchema.parse(request.body);
    return reply.code(202).send(await s.sourceControlAssist.reviewStaged(id(request), body));
  });
}
