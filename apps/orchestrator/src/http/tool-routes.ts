import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  checkpointCreateSchema,
  checkpointRestoreSchema,
  credentialInputSchema,
  credentialUpdateSchema,
  mcpServerInputSchema,
  operatorToolCallSchema,
  terminalOpenSchema,
  toolCallSchema,
  toolSessionOpenSchema,
  type PermissionLevel,
} from '@acc/shared';
import { policyCeiling, PROFILE_IDS, profileForRepository, type ProfileId } from '@acc/tools';
import { redact } from '@acc/security';
import type { AppServices } from '../app.js';
import { EngineError } from '../engine/engine.js';
import { agentWorkdir } from '../engine/task-repositories.js';
import { ToolService, type ToolScope, type ToolSession } from '../tools/service.js';

const idParam = z.object({ id: z.string().min(1).max(200) });
/** A model looks at a few pictures per call at most; more would crowd out the text. */
const MAX_IMAGES_PER_CALL = 3;
/** Query-string boolean: only the word `true` is true (z.coerce.boolean would read "false" as true). */
const flag = z.enum(['true', 'false']).optional().transform((v) => v === 'true');

/** Operator scope: a registered repository, the policy ceiling as the level, every capability listed. */
export function operatorScope(s: AppServices, repositoryId: string, profile: ProfileId = 'operator'): Omit<ToolScope, 'sessionId' | 'escalated'> {
  const repo = s.repositories.record(repositoryId);
  const settings = s.settings.get();
  const mode = repo.policyMode ?? settings.execution.policyMode;
  const auto = (repo.autoApproveUpToLevel ?? settings.autoApproveUpToLevel) as PermissionLevel;
  return {
    taskId: null,
    stageId: null,
    repositoryId: repo.id,
    cwd: repo.path,
    roots: [repo.path],
    stageLevel: 5,
    autoApproveUpToLevel: policyCeiling(mode, auto),
    mode,
    profile,
    protectedPaths: [],
  };
}

function bearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/**
 * Tool layer API (docs/plans/tool-layer-v2 §49). Typed endpoints only:
 * there is no route that runs an arbitrary command line as such — even an
 * operator's shell script is a `shell.*` capability, classified and subject
 * to the same policy as an agent's.
 */
export function registerToolRoutes(app: FastifyInstance, s: AppServices): void {
  const { tools } = s;

  // ----- tools and capabilities --------------------------------------------------

  app.get('/api/tools', async () => tools.tools());
  app.get('/api/tools/capabilities', async () => tools.capabilities());
  app.get('/api/tools/:id', async (request, reply) => tools.toolView(idParam.parse(request.params).id) ?? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Tool not found' } }));
  app.post('/api/tools/:id/check', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    if (!tools.registry.provider(id)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Tool not found' } });
    const { auth } = z.object({ auth: z.boolean().default(false) }).parse(request.body ?? {});
    return tools.check(id, { auth });
  });
  app.post('/api/tools/refresh', async (_request, reply) => {
    void tools.health.refresh({ force: true });
    return reply.code(202).send({ ok: true });
  });

  /** An operator's own tool call from the dashboard. Level-5 work needs the capability id typed as confirmation. */
  app.post('/api/tools/call', async (request) => {
    const body = operatorToolCallSchema.parse(request.body);
    const scope = { ...operatorScope(s, body.repositoryId), sessionId: null, escalated: new Set<string>() };
    const outcome = await tools.invoke({ capability: body.capability, input: body.input, origin: 'operator', scope, preApproved: body.confirmation === body.capability });
    return { execution: outcome.execution, result: { ...outcome.result, output: outcome.result.output }, decision: outcome.decision };
  });

  app.get('/api/tool-executions', async (request) => {
    const q = z.object({ taskId: z.string().max(100).optional(), capability: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).parse(request.query);
    return s.toolStore.listExecutions(q);
  });

  // ----- per task: the Execution tab --------------------------------------------------

  app.get('/api/tasks/:id/execution', async (request) => {
    const task = s.engine.task(idParam.parse(request.params).id);
    return {
      executions: s.toolStore.listExecutions({ taskId: task.id, limit: 500 }),
      processes: s.processes.list(task.id),
      terminals: s.terminals.list({ taskId: task.id }),
      recovery: s.toolStore.listRecovery(task.id),
      escalations: s.toolStore.listEscalations(task.id),
      checkpoints: s.chairman.store.listCheckpoints(task.id),
      workdir: task.git.workspacePath ?? task.git.worktreePath ?? null,
      policyMode: task.policyMode ?? s.settings.get().execution.policyMode,
    };
  });

  app.get('/api/tasks/:id/processes', async (request) => s.processes.list(s.engine.task(idParam.parse(request.params).id).id));

  app.post('/api/tasks/:id/processes/:processId/stop', async (request) => {
    const { id, processId } = z.object({ id: z.string(), processId: z.string().min(1).max(100) }).parse(request.params);
    const proc = s.toolStore.process(processId);
    if (!proc || proc.taskId !== id) throw new EngineError('Process not found for this task', 'NOT_FOUND');
    const stopped = await s.processes.stop(processId, 'stopped from the dashboard');
    const { processStartedAt: _unused, ...view } = stopped;
    return view;
  });

  app.get('/api/tasks/:id/checkpoints', async (request) => s.chairman.store.listCheckpoints(s.engine.task(idParam.parse(request.params).id).id));

  app.post('/api/tasks/:id/checkpoints', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = checkpointCreateSchema.parse(request.body);
    const action = await s.chairman.gateway.execute(id, { type: 'CREATE_CHECKPOINT', params: { label: body.label } }, { initiator: 'user', source: 'api' });
    if (action.status === 'completed') return reply.code(201).send(s.chairman.store.listCheckpoints(id).at(-1) ?? null);
    return reply.code(409).send({ error: { code: action.status === 'rejected' ? 'REJECTED' : 'FAILED', message: action.reason ?? 'The checkpoint was not created' } });
  });

  app.post('/api/tasks/:id/restore', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = checkpointRestoreSchema.parse(request.body ?? {});
    const action = await s.chairman.gateway.execute(id, { type: 'ROLLBACK_CHECKPOINT', params: body.checkpointId ? { checkpointId: body.checkpointId } : {} }, { initiator: 'user', source: 'api' });
    if (action.status === 'completed') return action;
    return reply.code(409).send({ error: { code: action.status === 'rejected' ? 'REJECTED' : 'FAILED', message: action.reason ?? 'The rollback did not complete' } });
  });

  // ----- background processes -------------------------------------------------------------

  app.get('/api/processes', async (request) => {
    const q = z.object({ live: flag }).parse(request.query);
    return s.toolStore.listProcesses({ live: q.live }).map(({ processStartedAt: _unused, ...view }) => view);
  });

  app.post('/api/processes/:id/stop', async (request) => {
    const { processStartedAt: _unused, ...view } = await s.processes.stop(idParam.parse(request.params).id, 'stopped from the dashboard');
    return view;
  });

  // ----- terminals (loopback only; see TerminalService) -------------------------------------

  app.get('/api/terminals', async (request) => {
    const q = z.object({ taskId: z.string().max(100).optional(), running: flag }).parse(request.query);
    return s.terminals.list(q);
  });

  app.post('/api/terminals', async (request, reply) => {
    const body = terminalOpenSchema.parse(request.body);
    let cwd: string;
    let taskId: string | null = null;
    if (body.taskId) {
      const task = s.engine.task(body.taskId);
      cwd = agentWorkdir(task, s.repositories.record(task.repositoryId));
      taskId = task.id;
    } else if (body.repositoryId) {
      cwd = s.repositories.record(body.repositoryId).path;
    } else throw new EngineError('Open a terminal in a repository or a task', 'INVALID_INPUT');
    const terminal = await s.terminals.open({ shell: body.shell, cwd: path.resolve(cwd), cols: body.cols, rows: body.rows, taskId, ownerKind: 'operator' });
    return reply.code(201).send(terminal);
  });

  app.get('/api/terminals/:id/output', async (request) => {
    const { since } = z.object({ since: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    return s.terminals.read(idParam.parse(request.params).id, since);
  });

  app.post('/api/terminals/:id/resize', async (request) => {
    const body = z.object({ cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }).parse(request.body);
    s.terminals.resize(idParam.parse(request.params).id, body.cols, body.rows);
    return { ok: true };
  });

  app.delete('/api/terminals/:id', async (request) => {
    await s.terminals.close(idParam.parse(request.params).id);
    return { ok: true };
  });

  // ----- MCP servers ------------------------------------------------------------------------

  app.get('/api/mcp', async () => s.mcp.list());
  app.post('/api/mcp', async (request, reply) => reply.code(201).send(await s.mcp.create(mcpServerInputSchema.parse(request.body))));
  app.patch('/api/mcp/:id', async (request) => s.mcp.update(idParam.parse(request.params).id, (request.body ?? {}) as never));
  app.delete('/api/mcp/:id', async (request) => {
    await s.mcp.remove(idParam.parse(request.params).id);
    return { ok: true };
  });
  app.post('/api/mcp/:id/check', async (request) => s.mcp.check(idParam.parse(request.params).id));

  // ----- credentials (values are write-only) ----------------------------------------------

  app.get('/api/credentials', async () => s.credentials.list());
  app.post('/api/credentials', async (request, reply) => reply.code(201).send(await s.credentials.create(credentialInputSchema.parse(request.body))));
  app.patch('/api/credentials/:id', async (request) => s.credentials.update(idParam.parse(request.params).id, credentialUpdateSchema.parse(request.body)));
  app.delete('/api/credentials/:id', async (request) => {
    s.credentials.delete(idParam.parse(request.params).id);
    return { ok: true };
  });

  // ----- privileged helper (validation only from the API; running asks through UAC) --------

  app.post('/api/privileged/validate', async (request) => {
    const body = z.object({ operation: z.string().min(1).max(60), params: z.record(z.string(), z.union([z.string().max(200), z.number()])).default({}) }).parse(request.body);
    return s.privileged.validate(body.operation, body.params);
  });

  // ----- tool sessions ------------------------------------------------------------------------

  /** Open an operator session for an external MCP client (the stdio bridge in operator mode). */
  app.post('/api/tool-sessions', async (request, reply) => {
    const body = toolSessionOpenSchema.parse(request.body);
    const repo = s.store.listRepositories().find((r) => r.id === body.repository || path.resolve(r.path).toLowerCase() === path.resolve(body.repository).toLowerCase());
    if (!repo) throw new EngineError(`No registered repository at ${body.repository}; add it in Repositories first`, 'NOT_FOUND');
    const profile = (PROFILE_IDS as readonly string[]).includes(body.profile ?? '') ? (body.profile as ProfileId) : profileForRepository(repo.tooling, 2);
    const session = tools.openSession(operatorScope(s, repo.id, profile), 'operator', 12 * 3600_000);
    return reply.code(201).send({ token: session.token, expiresAt: new Date(session.expiresAt).toISOString(), profile });
  });

  const withSession = (request: FastifyRequest, reply: FastifyReply): ToolSession | null => {
    const session = tools.sessionByToken(bearer(request));
    if (!session) {
      void reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Missing or expired tool session' } });
      return null;
    }
    return session;
  };

  app.get('/api/tool-session/tools', async (request, reply) => {
    const session = withSession(request, reply);
    if (!session) return reply;
    const { scope } = session;
    return { session: { taskId: scope.taskId, stageLevel: scope.stageLevel, profile: scope.profile, mode: scope.mode }, tools: tools.sessionTools(session) };
  });

  app.post('/api/tool-session/find', async (request, reply) => {
    const session = withSession(request, reply);
    if (!session) return reply;
    const { query } = z.object({ query: z.string().min(1).max(200) }).parse(request.body);
    return { text: tools.find(session, query) };
  });

  app.post('/api/tool-session/call', async (request, reply) => {
    const session = withSession(request, reply);
    if (!session) return reply;
    const body = toolCallSchema.parse(request.body);
    const outcome = await tools.invoke({ capability: body.capability, input: body.input, origin: session.kind === 'agent' ? 'agent' : 'operator', scope: session.scope });
    // Pictures the call made for the model (a screenshot it asked to see) travel with the answer only; they are never stored.
    const images = (outcome.result.images ?? []).slice(0, MAX_IMAGES_PER_CALL).map((i) => ({ name: i.name, mime: i.mime, data: i.data.toString('base64') }));
    return { ok: outcome.result.ok, summary: outcome.result.summary, decision: outcome.decision, executionId: outcome.execution.id, text: redact(ToolService.formatForModel(outcome)), images };
  });
}
