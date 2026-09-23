import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { changesSince, diffSince, git, isGitRepository } from '@acc/git';
import { redact } from '@acc/security';
import {
  ATTENTION_TASK_STATUSES,
  ROLES,
  TASK_STATUSES,
  approvalDecisionSchema,
  assignmentChangeSchema,
  chairmanActionBodySchema,
  chairmanMessageBodySchema,
  createRepositorySchema,
  createTaskSchema,
  directiveSchema,
  modelInputSchema,
  promptTemplateUpdateSchema,
  rerouteSchema,
  retrySchema,
  updateAgentSchema,
  updateRepositorySchema,
  updateSettingsSchema,
  updateTaskSchema,
  type ServiceHealth,
  type TaskChanges,
  type TaskStatus,
} from '@acc/shared';
import type { AppServices } from '../app.js';
import { EngineError } from '../engine/engine.js';
import { AgentNotFoundError } from '../services/agents.js';
import { toArtifactView } from '../services/artifacts.js';
import { RepositoryError } from '../services/repositories.js';
import { WorkflowError } from '../services/workflows.js';
import { SOURCE_CONTROL_HTTP_STATUS, SourceControlError } from '../source-control/errors.js';
import { CredentialError } from '../tools/credentials.js';
import { McpError } from '../tools/mcp.js';
import { TerminalError } from '../tools/terminals.js';

const idParam = z.object({ id: z.string().min(1).max(200) });

function sendError(reply: FastifyReply, status: number, code: string, message: string, details?: unknown) {
  return reply.code(status).send({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
}

/** Map domain errors to HTTP responses in one place. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return sendError(reply, 400, 'VALIDATION', error.issues[0]?.message ?? 'Invalid request', error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    if (error instanceof EngineError) {
      const status = { NOT_FOUND: 404, INVALID_STATE: 409, INVALID_INPUT: 400, CONFIRMATION_REQUIRED: 422 }[error.code];
      return sendError(reply, status, error.code, error.message);
    }
    if (error instanceof RepositoryError) {
      const status = { NOT_FOUND: 404, INVALID_PATH: 400, DUPLICATE: 409, IN_USE: 409 }[error.code];
      return sendError(reply, status, error.code, error.message);
    }
    if (error instanceof WorkflowError) {
      const status = { NOT_FOUND: 404, INVALID: 400, READ_ONLY: 409, DUPLICATE: 409 }[error.code];
      return sendError(reply, status, error.code, error.message, error.issues.length ? error.issues : undefined);
    }
    if (error instanceof AgentNotFoundError) return sendError(reply, 404, 'NOT_FOUND', error.message);
    if (error instanceof SourceControlError) {
      // Messages are already redacted; details carry paths, operation ids and findings, never secrets.
      return sendError(reply, SOURCE_CONTROL_HTTP_STATUS[error.code], error.code, error.message, error.details);
    }
    if (error instanceof TerminalError) {
      const status = { NOT_FOUND: 404, DISABLED: 403, UNAVAILABLE: 503, LIMIT: 429, DENIED: 403 }[error.code];
      return sendError(reply, status, error.code, error.message);
    }
    if (error instanceof CredentialError) {
      const status = { NOT_FOUND: 404, DUPLICATE: 409, INVALID: 400, KEY_UNAVAILABLE: 503 }[error.code];
      return sendError(reply, status, error.code, error.message);
    }
    if (error instanceof McpError) {
      const status = { NOT_FOUND: 404, DUPLICATE: 409, INVALID: 400 }[error.code];
      return sendError(reply, status, error.code, error.message);
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) return sendError(reply, statusCode, 'BAD_REQUEST', (error as Error).message);
    request.log.error({ err: { message: redact((error as Error).message), stack: (error as Error).stack } }, 'request failed');
    return sendError(reply, 500, 'INTERNAL', 'Internal error. Details are in the orchestrator log.');
  });
}

export function registerRoutes(app: FastifyInstance, s: AppServices): void {
  const { engine, store, views } = s;

  // ----- service ------------------------------------------------------------

  let gitInfo: Promise<ServiceHealth['git']> | null = null;
  const detectGit = (): Promise<ServiceHealth['git']> =>
    (gitInfo ??= git(process.cwd(), ['--version'])
      .then((r) => ({ found: r.code === 0, version: /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null }))
      .catch(() => ({ found: false, version: null })));

  app.get('/api/health', async (): Promise<ServiceHealth> => {
    const address = app.server.address();
    return {
      simulatedAgents: s.config.simulatedAgents,
      git: await detectGit(),
      ok: true,
      version: s.config.version,
      startedAt: s.startedAt,
      billingMode: s.settings.get().billingMode,
      dataDir: s.config.dataDir,
      host: s.config.host,
      port: typeof address === 'object' && address ? address.port : s.config.port,
    };
  });

  app.get('/api/overview', async () => {
    const summaries = (statuses: TaskStatus[], limit = 50) => store.listTasks({ statuses, limit }).map((t) => views.summary(t));
    return {
      counts: views.overview(),
      active: summaries(['RUNNING', 'QUEUED', 'PAUSED']),
      attention: summaries([...ATTENTION_TASK_STATUSES]),
      recent: store.listTasks({ limit: 12 }).map((t) => views.summary(t)),
      simulatedAgents: s.config.simulatedAgents,
    };
  });

  // ----- tasks --------------------------------------------------------------

  app.get('/api/tasks', async (request) => {
    const q = z
      .object({
        status: z.string().optional(),
        repositoryId: z.string().optional(),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.string().optional(),
      })
      .parse(request.query);
    const statuses = q.status?.split(',').filter((st): st is TaskStatus => (TASK_STATUSES as readonly string[]).includes(st));
    const tasks = store.listTasks({ statuses, repositoryId: q.repositoryId, search: q.q, limit: q.limit + 1, before: q.before });
    const page = tasks.slice(0, q.limit);
    return { items: page.map((t) => views.summary(t)), nextCursor: tasks.length > q.limit ? (page.at(-1)?.updatedAt ?? null) : null };
  });

  app.post('/api/tasks', async (request, reply) => {
    const detail = await engine.createTask(createTaskSchema.parse(request.body));
    return reply.code(201).send(detail);
  });

  app.get('/api/tasks/:id', async (request) => engine.detail(idParam.parse(request.params).id));

  app.patch('/api/tasks/:id', async (request) => engine.updateDraft(idParam.parse(request.params).id, updateTaskSchema.parse(request.body)));

  const command = (name: string, fn: (id: string, body: unknown) => Promise<unknown>) =>
    app.post(`/api/tasks/:id/${name}`, async (request) => {
      const { id } = idParam.parse(request.params);
      const result = await fn(id, request.body ?? {});
      return result ?? engine.detail(id);
    });
  command('start', (id) => engine.start(id));
  command('pause', (id) => engine.pause(id));
  command('resume', (id) => engine.resume(id));
  command('cancel', (id) => engine.cancel(id));
  command('retry', (id, body) => engine.retry(id, retrySchema.parse(body).stageKey));
  command('reroute', (id, body) => engine.reroute(id, rerouteSchema.parse(body)));
  command('assignments', async (id, body) => engine.changeAssignment(id, assignmentChangeSchema.parse(body)));
  command('directives', (id, body) => engine.addDirective(id, directiveSchema.parse(body)));

  // ----- chairman (docs/systems/chairman.md) ---------------------------------

  app.get('/api/tasks/:id/chairman', async (request) => {
    const { id } = idParam.parse(request.params);
    engine.task(id);
    return s.chairman.overview(id);
  });

  app.get('/api/tasks/:id/chairman/messages', async (request) => {
    const { id } = idParam.parse(request.params);
    const q = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(request.query);
    engine.task(id);
    return s.chairman.store.listMessages(id, q);
  });

  app.post('/api/tasks/:id/chairman/messages', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = chairmanMessageBodySchema.parse(request.body);
    const { message, duplicate } = s.chat.post(id, body.text, body.clientMessageId);
    return reply.code(duplicate ? 200 : 202).send(message);
  });

  // Direct controls from the UI (e.g. removing a directive) use the same gateway as chat.
  app.post('/api/tasks/:id/chairman/actions', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = chairmanActionBodySchema.parse(request.body);
    const action = await s.chairman.gateway.execute(id, body.action, { initiator: 'user', source: 'api', idempotencyKey: body.idempotencyKey });
    if (action.status === 'completed') return action;
    return sendError(reply, 409, action.status === 'rejected' ? 'REJECTED' : 'FAILED', action.reason ?? 'The action did not complete', action);
  });

  app.get('/api/tasks/:id/directives', async (request) => {
    const { id } = idParam.parse(request.params);
    engine.task(id);
    return store.listDirectives(id);
  });

  app.get('/api/tasks/:id/events', async (request) => {
    const { id } = idParam.parse(request.params);
    const q = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(2000).default(500) }).parse(request.query);
    engine.task(id);
    return store.listEvents(id, q);
  });

  app.get('/api/tasks/:id/executions', async (request) => {
    const { id } = idParam.parse(request.params);
    engine.task(id);
    return store.listExecutions(id);
  });

  app.get('/api/tasks/:id/tests', async (request) => {
    const { id } = idParam.parse(request.params);
    engine.task(id);
    return store.listTestRuns(id);
  });

  app.get('/api/tasks/:id/artifacts', async (request) => {
    const { id } = idParam.parse(request.params);
    engine.task(id);
    return store.listArtifacts(id).map(toArtifactView);
  });

  app.get('/api/tasks/:id/approvals', async (request) => {
    const { id } = idParam.parse(request.params);
    engine.task(id);
    return store.listApprovals({ taskId: id }).map((a) => views.approval(a));
  });

  app.get('/api/tasks/:id/changes', async (request): Promise<TaskChanges> => {
    const task = engine.task(idParam.parse(request.params).id);
    const repo = s.repositories.record(task.repositoryId);
    const baseline = task.git.baselineSnapshotId ? store.getSnapshot(task.git.baselineSnapshotId) : null;
    const status = await s.repositories.status(repo, true);
    const base = {
      baselineCommit: task.git.baselineCommit,
      baselineBranch: task.git.baselineBranch,
      taskBranch: task.git.taskBranch,
      currentBranch: status.branch,
      preexistingWarning: task.git.preexistingChanges.length > 0,
    };
    if (!baseline || !(await isGitRepository(repo.path))) return { ...base, files: [], totals: { files: 0, additions: 0, deletions: 0 } };
    const files = await changesSince(repo.path, baseline);
    return {
      ...base,
      files,
      totals: {
        files: files.filter((f) => f.origin !== 'preexisting').length,
        additions: files.filter((f) => f.origin !== 'preexisting').reduce((n, f) => n + (f.additions ?? 0), 0),
        deletions: files.filter((f) => f.origin !== 'preexisting').reduce((n, f) => n + (f.deletions ?? 0), 0),
      },
    };
  });

  app.get('/api/tasks/:id/diff', async (request) => {
    const task = engine.task(idParam.parse(request.params).id);
    const { path: file } = z.object({ path: z.string().max(1000).optional() }).parse(request.query);
    const baseline = task.git.baselineSnapshotId ? store.getSnapshot(task.git.baselineSnapshotId) : null;
    if (!baseline) return { diff: '', truncated: false };
    const repo = s.repositories.record(task.repositoryId);
    if (file !== undefined && (file.includes('..') || /^[/\\]|^[A-Za-z]:/.test(file))) {
      throw new EngineError('Invalid path', 'INVALID_INPUT');
    }
    const { diff, truncated } = await diffSince(repo.path, baseline, { path: file, maxBytes: 1_000_000 });
    return { diff: redact(diff), truncated };
  });

  // ----- executions & logs ---------------------------------------------------

  app.get('/api/executions/:id', async (request, reply) => {
    const execution = store.getExecution(idParam.parse(request.params).id);
    return execution ?? sendError(reply, 404, 'NOT_FOUND', 'Execution not found');
  });

  app.get('/api/executions/:id/logs', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (!store.getExecution(id)) return sendError(reply, 404, 'NOT_FOUND', 'Execution not found');
    const q = z
      .object({
        after: z.coerce.number().int().min(-1).default(-1),
        limit: z.coerce.number().int().min(1).max(5000).default(1000),
        stream: z.enum(['stdout', 'stderr', 'system']).optional(),
        q: z.string().max(200).optional(),
        tail: z.coerce.number().int().min(1).max(5000).optional(),
      })
      .parse(request.query);
    if (q.tail) return store.tailLogLines(id, q.tail);
    return store.listLogLines(id, { after: q.after, limit: q.limit, stream: q.stream, search: q.q });
  });

  // ----- artifacts ------------------------------------------------------------

  app.get('/api/artifacts/:id/content', async (request, reply) => {
    const rec = store.getArtifact(idParam.parse(request.params).id);
    if (!rec) return sendError(reply, 404, 'NOT_FOUND', 'Artifact not found');
    const { content, truncated } = await s.artifacts.read(rec);
    return { artifact: toArtifactView(rec), content, truncated };
  });

  app.get('/api/artifacts/:id/download', async (request, reply) => {
    const rec = store.getArtifact(idParam.parse(request.params).id);
    if (!rec) return sendError(reply, 404, 'NOT_FOUND', 'Artifact not found');
    // Artifacts are written as UTF-8; say so, or viewers fall back to a legacy codepage.
    const textual = /^text\/|^application\/(json|x-ndjson)/.test(rec.mime) && !/charset=/i.test(rec.mime);
    reply.header('content-type', textual ? `${rec.mime}; charset=utf-8` : rec.mime);
    reply.header('content-disposition', `attachment; filename="${rec.name.replace(/"/g, '')}"`);
    return reply.send(createReadStream(s.artifacts.absolutePath(rec)));
  });

  // ----- approvals --------------------------------------------------------------

  app.get('/api/approvals', async (request) => {
    const { status } = z.object({ status: z.enum(['pending', 'approved', 'denied', 'cancelled', 'all']).default('pending') }).parse(request.query);
    return store.listApprovals(status === 'all' ? { limit: 200 } : { status, limit: 200 }).map((a) => views.approval(a));
  });

  app.post('/api/approvals/:id/approve', async (request) => {
    const { id } = idParam.parse(request.params);
    await engine.resolveApproval(id, 'approve', approvalDecisionSchema.parse(request.body ?? {}));
    return views.approval(store.getApproval(id)!);
  });

  app.post('/api/approvals/:id/deny', async (request) => {
    const { id } = idParam.parse(request.params);
    await engine.resolveApproval(id, 'deny', approvalDecisionSchema.parse(request.body ?? {}));
    return views.approval(store.getApproval(id)!);
  });

  // ----- agents -------------------------------------------------------------------

  app.get('/api/agents', async () => s.agents.list());
  app.post('/api/agents/refresh', async () => s.agents.refresh());
  app.post('/api/agents/:id/refresh', async (request) => {
    const { id } = idParam.parse(request.params);
    s.agents.adapter(id);
    await s.agents.refresh(id);
    return s.agents.get(id);
  });
  app.patch('/api/agents/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const info = s.agents.updateSettings(id, updateAgentSchema.parse(request.body));
    void s.agents.refresh(id);
    return info;
  });
  app.post('/api/agents/:id/models', async (request) => {
    const { id } = idParam.parse(request.params);
    const body = modelInputSchema.parse(request.body);
    return s.agents.addModel(id, body.modelId, body.label, body.efforts);
  });
  app.delete('/api/agents/:id/models/:modelId', async (request, reply) => {
    const { id, modelId } = z.object({ id: z.string(), modelId: z.string() }).parse(request.params);
    if (!s.agents.removeModel(id, modelId)) return sendError(reply, 404, 'NOT_FOUND', 'Only models you added can be removed');
    return reply.code(204).send();
  });

  // ----- workflows ----------------------------------------------------------------

  app.get('/api/workflows', async () => s.workflows.list());
  app.get('/api/workflows/:id', async (request) => s.workflows.get(idParam.parse(request.params).id));
  app.post('/api/workflows/validate', async (request) => s.workflows.validate(request.body));
  app.put('/api/workflows/:id', async (request) => s.workflows.save(idParam.parse(request.params).id, request.body));
  app.post('/api/workflows/:id/duplicate', async (request, reply) => {
    const { name } = z.object({ name: z.string().min(1).max(60).optional() }).parse(request.body ?? {});
    return reply.code(201).send(s.workflows.duplicate(idParam.parse(request.params).id, name));
  });
  app.delete('/api/workflows/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    s.workflows.remove(id);
    const settings = s.settings.get();
    if (settings.defaultWorkflowId === id) s.settings.update({ defaultWorkflowId: 'normal-development' });
    for (const repo of store.listRepositories().filter((r) => r.defaultWorkflowId === id)) {
      await s.repositories.update(repo.id, { defaultWorkflowId: null });
    }
    return reply.code(204).send();
  });

  // ----- repositories ---------------------------------------------------------------

  app.get('/api/repositories', async () => s.repositories.list());
  app.post('/api/repositories', async (request, reply) => {
    const body = createRepositorySchema.parse(request.body);
    return reply.code(201).send(await s.repositories.add(body.path, body.name));
  });
  app.get('/api/repositories/:id', async (request) => s.repositories.get(idParam.parse(request.params).id, true));
  app.patch('/api/repositories/:id', async (request) => {
    const patch = updateRepositorySchema.parse(request.body);
    if (patch.defaultWorkflowId) s.workflows.get(patch.defaultWorkflowId);
    return s.repositories.update(idParam.parse(request.params).id, patch);
  });
  app.post('/api/repositories/:id/redetect', async (request) => s.repositories.redetect(idParam.parse(request.params).id));
  app.delete('/api/repositories/:id', async (request, reply) => {
    s.repositories.remove(idParam.parse(request.params).id);
    return reply.code(204).send();
  });

  // ----- repository automation (discovery + background sync) --------------------------

  app.get('/api/repository-automation', async () => s.repositoryAutomation.status());
  /** Starts a run as enabled in settings and answers at once; progress arrives over the WebSocket. */
  app.post('/api/repository-automation/run', async (request, reply) => {
    void s.repositoryAutomation.run('manual').catch((error: unknown) => request.log.error(`Repository automation run failed: ${(error as Error).message}`));
    return reply.code(202).send(s.repositoryAutomation.status());
  });

  // ----- settings & prompts ---------------------------------------------------------

  app.get('/api/settings', async () => s.settings.get());
  app.patch('/api/settings', async (request) => {
    const patch = updateSettingsSchema.parse(request.body);
    if (patch.defaultWorkflowId) s.workflows.get(patch.defaultWorkflowId);
    const before = s.settings.get().billingMode;
    const next = s.settings.update(patch);
    // Billing mode changes what "connected" means; re-verify every agent.
    if (patch.billingMode && patch.billingMode !== before) void s.agents.refresh();
    return next;
  });

  app.get('/api/prompts', async () => s.prompts.list());
  const roleParam = z.object({ role: z.enum(ROLES) });
  app.put('/api/prompts/:role', async (request) => s.prompts.update(roleParam.parse(request.params).role, promptTemplateUpdateSchema.parse(request.body).body));
  app.post('/api/prompts/:role/reset', async (request) => s.prompts.reset(roleParam.parse(request.params).role));
}
