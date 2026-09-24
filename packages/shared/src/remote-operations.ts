import { z, type ZodType } from 'zod';
import { chairmanActionBodySchema, chairmanMessageBodySchema } from './chairman.js';
import {
  approvalDecisionSchema,
  assignmentChangeSchema,
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
} from './schemas.js';
import {
  commitRequestSchema,
  fetchRequestSchema,
  publishRequestSchema,
  reviewStagedRequestSchema,
  stageRequestSchema,
  suggestMessageRequestSchema,
  syncRequestSchema,
  unstageRequestSchema,
} from './source-control.js';
import { checkpointCreateSchema, checkpointRestoreSchema, operatorToolCallSchema, terminalOpenSchema } from './tools.js';
import { budgetInputSchema, budgetUpdateSchema, pricingInputSchema } from './usage.js';
import { pathParamSchema, remoteQuerySchema, REMOTE_LIMITS, type CommandPrecondition } from './remote.js';

/**
 * The typed remote operation catalog: the only things the cloud can ask a
 * node to do. Each entry names one existing local API route by a fixed
 * method and path template; the cloud never chooses a path, never sends
 * shell text, and an operation not listed here does not exist remotely.
 *
 * - `read` operations are answered live over the node's WebSocket (typed RPC).
 * - `command` operations are durable remote commands (D1 row first, then the
 *   node records a receipt before it runs anything; see remote-node.md).
 *
 * Never remote: shutdown, tool sessions, the privileged helper, credential
 * values (create/update), MCP server definitions (commands and env), adding a
 * repository by local path, and the node's own remote settings (/api/remote/*).
 */

export type RemoteOperationKind = 'read' | 'command';
/** Extra local permission the node requires; both default to off. */
export type RemoteGate = 'terminals' | 'tools';

export interface RemoteOperation {
  op: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Local route template, `:name` segments filled from validated params. */
  path: string;
  kind: RemoteOperationKind;
  /** Cloud-side validation of the JSON body; the node's route validates again. */
  body?: ZodType;
  gate?: RemoteGate;
  /** How the cloud binds the command to the state the user saw. */
  precondition?: CommandPrecondition['kind'];
  /** The cloud may answer from its D1 mirror while the node is offline. */
  offline?: boolean;
  /** Remotely started mutating work takes the cloud repository lease. */
  lease?: boolean;
  /** Seconds a command may wait before it expires. */
  ttlSeconds?: number;
  /** The response is binary or text and travels base64-encoded. */
  binary?: boolean;
}

const anyBody = z.record(z.string(), z.unknown());
const emptyBody = z.object({}).passthrough();
const NORMAL_TTL = 120;
/** Approvals are bound to the exact approval and expire fast. */
const APPROVAL_TTL = 60;
/** A task created with "run when the node is online". */
export const QUEUED_TASK_TTL_SECONDS = 24 * 60 * 60;

const r = (op: string, method: RemoteOperation['method'], path: string, extra: Partial<RemoteOperation> = {}): RemoteOperation => ({ op, method, path, kind: 'read', ...extra });
const c = (op: string, method: RemoteOperation['method'], path: string, extra: Partial<RemoteOperation> = {}): RemoteOperation => ({ op, method, path, kind: 'command', ttlSeconds: NORMAL_TTL, ...extra });

const SC = '/api/repositories/:id/source-control';

export const REMOTE_OPERATIONS: readonly RemoteOperation[] = [
  // service
  r('service.health', 'GET', '/api/health'),
  r('overview.get', 'GET', '/api/overview', { offline: true }),
  // tasks
  r('task.list', 'GET', '/api/tasks', { offline: true }),
  c('task.create', 'POST', '/api/tasks', { body: createTaskSchema, lease: true }),
  r('task.get', 'GET', '/api/tasks/:id', { offline: true }),
  c('task.update', 'PATCH', '/api/tasks/:id', { body: updateTaskSchema, precondition: 'taskVersion' }),
  c('task.start', 'POST', '/api/tasks/:id/start', { body: emptyBody, precondition: 'taskVersion', lease: true }),
  c('task.pause', 'POST', '/api/tasks/:id/pause', { body: emptyBody }),
  c('task.resume', 'POST', '/api/tasks/:id/resume', { body: emptyBody }),
  c('task.cancel', 'POST', '/api/tasks/:id/cancel', { body: emptyBody }),
  c('task.retry', 'POST', '/api/tasks/:id/retry', { body: retrySchema, precondition: 'taskVersion' }),
  c('task.reroute', 'POST', '/api/tasks/:id/reroute', { body: rerouteSchema, precondition: 'taskVersion' }),
  c('task.assignments', 'POST', '/api/tasks/:id/assignments', { body: assignmentChangeSchema, precondition: 'taskVersion' }),
  c('task.directive', 'POST', '/api/tasks/:id/directives', { body: directiveSchema }),
  r('task.directives', 'GET', '/api/tasks/:id/directives'),
  r('task.events', 'GET', '/api/tasks/:id/events', { offline: true }),
  r('task.executions', 'GET', '/api/tasks/:id/executions'),
  r('task.tests', 'GET', '/api/tasks/:id/tests'),
  r('task.artifacts', 'GET', '/api/tasks/:id/artifacts', { offline: true }),
  r('task.approvals', 'GET', '/api/tasks/:id/approvals'),
  r('task.changes', 'GET', '/api/tasks/:id/changes'),
  r('task.diff', 'GET', '/api/tasks/:id/diff'),
  // chairman
  r('chairman.overview', 'GET', '/api/tasks/:id/chairman'),
  r('chairman.messages', 'GET', '/api/tasks/:id/chairman/messages'),
  c('chairman.message', 'POST', '/api/tasks/:id/chairman/messages', { body: chairmanMessageBodySchema }),
  c('chairman.action', 'POST', '/api/tasks/:id/chairman/actions', { body: chairmanActionBodySchema }),
  // executions, logs, artifacts
  r('execution.get', 'GET', '/api/executions/:id'),
  r('execution.logs', 'GET', '/api/executions/:id/logs', { offline: true }),
  r('artifact.content', 'GET', '/api/artifacts/:id/content', { offline: true }),
  r('artifact.download', 'GET', '/api/artifacts/:id/download', { binary: true }),
  // approvals
  r('approval.list', 'GET', '/api/approvals', { offline: true }),
  c('approval.approve', 'POST', '/api/approvals/:id/approve', { body: approvalDecisionSchema, precondition: 'approval', ttlSeconds: APPROVAL_TTL }),
  c('approval.deny', 'POST', '/api/approvals/:id/deny', { body: approvalDecisionSchema, precondition: 'approval', ttlSeconds: APPROVAL_TTL }),
  // agents
  r('agent.list', 'GET', '/api/agents', { offline: true }),
  r('skill.list', 'GET', '/api/skills'),
  c('agent.refreshAll', 'POST', '/api/agents/refresh', { body: emptyBody }),
  c('agent.refresh', 'POST', '/api/agents/:id/refresh', { body: emptyBody }),
  c('agent.update', 'PATCH', '/api/agents/:id', { body: updateAgentSchema }),
  c('agent.modelAdd', 'POST', '/api/agents/:id/models', { body: modelInputSchema }),
  c('agent.modelRemove', 'DELETE', '/api/agents/:id/models/:modelId'),
  // workflows
  r('workflow.list', 'GET', '/api/workflows'),
  r('workflow.get', 'GET', '/api/workflows/:id'),
  r('workflow.validate', 'POST', '/api/workflows/validate', { body: anyBody }),
  c('workflow.save', 'PUT', '/api/workflows/:id', { body: anyBody }),
  c('workflow.duplicate', 'POST', '/api/workflows/:id/duplicate', { body: anyBody }),
  c('workflow.delete', 'DELETE', '/api/workflows/:id'),
  // repositories (adding one by local path stays local)
  r('repository.list', 'GET', '/api/repositories', { offline: true }),
  r('repository.get', 'GET', '/api/repositories/:id'),
  c('repository.update', 'PATCH', '/api/repositories/:id', { body: updateRepositorySchema }),
  c('repository.redetect', 'POST', '/api/repositories/:id/redetect', { body: emptyBody }),
  c('repository.remove', 'DELETE', '/api/repositories/:id'),
  r('repositoryAutomation.status', 'GET', '/api/repository-automation'),
  c('repositoryAutomation.run', 'POST', '/api/repository-automation/run', { body: emptyBody }),
  // settings and prompts
  r('settings.get', 'GET', '/api/settings'),
  c('settings.update', 'PATCH', '/api/settings', { body: updateSettingsSchema }),
  r('prompt.list', 'GET', '/api/prompts'),
  c('prompt.update', 'PUT', '/api/prompts/:role', { body: promptTemplateUpdateSchema }),
  c('prompt.reset', 'POST', '/api/prompts/:role/reset', { body: emptyBody }),
  // source control (Git runs only on the node, through SourceControlService)
  r('sourceControl.snapshot', 'GET', SC),
  r('sourceControl.refresh', 'POST', `${SC}/refresh`, { body: emptyBody }),
  r('sourceControl.diff', 'GET', `${SC}/diff`),
  r('sourceControl.history', 'GET', `${SC}/history`),
  r('sourceControl.commit', 'GET', `${SC}/commits/:sha`),
  r('sourceControl.commitDiff', 'GET', `${SC}/commits/:sha/diff`),
  r('sourceControl.operations', 'GET', `${SC}/operations`),
  r('sourceControl.review', 'GET', `${SC}/review`),
  c('sourceControl.stage', 'POST', `${SC}/stage`, { body: stageRequestSchema }),
  c('sourceControl.unstage', 'POST', `${SC}/unstage`, { body: unstageRequestSchema }),
  c('sourceControl.commitStaged', 'POST', `${SC}/commit`, { body: commitRequestSchema }),
  c('sourceControl.fetch', 'POST', `${SC}/fetch`, { body: fetchRequestSchema }),
  c('sourceControl.sync', 'POST', `${SC}/sync`, { body: syncRequestSchema }),
  c('sourceControl.publish', 'POST', `${SC}/publish`, { body: publishRequestSchema }),
  c('sourceControl.suggestMessage', 'POST', `${SC}/suggest-message`, { body: suggestMessageRequestSchema }),
  c('sourceControl.reviewStaged', 'POST', `${SC}/review-staged`, { body: reviewStagedRequestSchema }),
  // tools: metadata is visible; the operator tool call is gated
  r('tool.list', 'GET', '/api/tools'),
  r('tool.capabilities', 'GET', '/api/tools/capabilities'),
  r('tool.get', 'GET', '/api/tools/:id'),
  c('tool.check', 'POST', '/api/tools/:id/check', { body: anyBody }),
  c('tool.refresh', 'POST', '/api/tools/refresh', { body: emptyBody }),
  c('tool.call', 'POST', '/api/tools/call', { body: operatorToolCallSchema, gate: 'tools' }),
  r('toolExecution.list', 'GET', '/api/tool-executions'),
  r('task.execution', 'GET', '/api/tasks/:id/execution'),
  r('task.processes', 'GET', '/api/tasks/:id/processes'),
  c('task.processStop', 'POST', '/api/tasks/:id/processes/:processId/stop', { body: emptyBody }),
  r('task.checkpoints', 'GET', '/api/tasks/:id/checkpoints'),
  c('task.checkpointCreate', 'POST', '/api/tasks/:id/checkpoints', { body: checkpointCreateSchema }),
  c('task.restore', 'POST', '/api/tasks/:id/restore', { body: checkpointRestoreSchema }),
  r('process.list', 'GET', '/api/processes'),
  c('process.stop', 'POST', '/api/processes/:id/stop', { body: emptyBody }),
  // terminals: off unless the node enables remote terminals locally
  r('terminal.list', 'GET', '/api/terminals'),
  c('terminal.open', 'POST', '/api/terminals', { body: terminalOpenSchema, gate: 'terminals' }),
  r('terminal.output', 'GET', '/api/terminals/:id/output', { gate: 'terminals' }),
  c('terminal.resize', 'POST', '/api/terminals/:id/resize', { body: anyBody, gate: 'terminals' }),
  c('terminal.close', 'DELETE', '/api/terminals/:id'),
  // MCP servers and credentials: metadata only
  r('mcp.list', 'GET', '/api/mcp'),
  c('mcp.check', 'POST', '/api/mcp/:id/check', { body: emptyBody }),
  c('mcp.remove', 'DELETE', '/api/mcp/:id'),
  r('credential.list', 'GET', '/api/credentials'),
  c('credential.remove', 'DELETE', '/api/credentials/:id'),
  // usage
  r('usage.overview', 'GET', '/api/usage/overview'),
  r('usage.trend', 'GET', '/api/usage/trend'),
  r('usage.breakdown', 'GET', '/api/usage/breakdown/:dimension'),
  r('usage.tasks', 'GET', '/api/usage/tasks'),
  r('usage.task', 'GET', '/api/usage/tasks/:id'),
  r('usage.taskLive', 'GET', '/api/usage/tasks/:id/live'),
  r('usage.providers', 'GET', '/api/usage/providers'),
  r('usage.events', 'GET', '/api/usage/events', { offline: true }),
  r('usage.event', 'GET', '/api/usage/events/:id'),
  r('usage.anomalies', 'GET', '/api/usage/anomalies'),
  r('usage.health', 'GET', '/api/usage/health'),
  r('usage.export', 'GET', '/api/usage/export', { binary: true }),
  r('usage.budgets', 'GET', '/api/usage/budgets'),
  r('usage.pricing', 'GET', '/api/usage/pricing'),
  c('usage.reconcile', 'POST', '/api/usage/reconcile', { body: emptyBody }),
  c('usage.capacityRefresh', 'POST', '/api/usage/capacity/refresh', { body: emptyBody }),
  c('usage.budgetCreate', 'POST', '/api/usage/budgets', { body: budgetInputSchema }),
  c('usage.budgetUpdate', 'PATCH', '/api/usage/budgets/:id', { body: budgetUpdateSchema }),
  c('usage.budgetRemove', 'DELETE', '/api/usage/budgets/:id'),
  c('usage.pricingAdd', 'POST', '/api/usage/pricing', { body: pricingInputSchema }),
  c('usage.recalculate', 'POST', '/api/usage/recalculate', { body: anyBody }),
];

const BY_OP = new Map(REMOTE_OPERATIONS.map((o) => [o.op, o]));

export function remoteOperation(op: string): RemoteOperation | undefined {
  return BY_OP.get(op);
}

interface CompiledRoute {
  operation: RemoteOperation;
  segments: string[];
}

const COMPILED: CompiledRoute[] = REMOTE_OPERATIONS.map((operation) => ({ operation, segments: operation.path.split('/').filter(Boolean) }));

/** Match an incoming request to an operation. Literal segments win over parameters (`/refresh` before `/:id`). */
export function matchRemoteOperation(method: string, pathname: string): { operation: RemoteOperation; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter(Boolean);
  let best: { operation: RemoteOperation; params: Record<string, string>; literals: number } | null = null;
  for (const route of COMPILED) {
    if (route.operation.method !== method.toUpperCase() || route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let literals = 0;
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const seg = route.segments[i]!;
      const part = parts[i]!;
      if (seg.startsWith(':')) {
        let decoded: string;
        try {
          decoded = decodeURIComponent(part);
        } catch {
          ok = false;
          break;
        }
        if (!pathParamSchema.safeParse(decoded).success) {
          ok = false;
          break;
        }
        params[seg.slice(1)] = decoded;
      } else if (seg === part) literals++;
      else {
        ok = false;
        break;
      }
    }
    if (ok && (!best || literals > best.literals)) best = { operation: route.operation, params, literals };
  }
  return best ? { operation: best.operation, params: best.params } : null;
}

/** Build the local URL for an operation. Every parameter is validated and percent-encoded; unknown or missing ones are refused. */
export function localPathFor(operation: RemoteOperation, params: Record<string, string>, query: Record<string, string>): string {
  const names = operation.path.split('/').filter((s) => s.startsWith(':')).map((s) => s.slice(1));
  const extra = Object.keys(params).filter((k) => !names.includes(k));
  if (extra.length) throw new Error(`Unexpected parameter: ${extra[0]}`);
  const path = operation.path.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined || !pathParamSchema.safeParse(value).success) throw new Error(`Invalid parameter: ${name}`);
    return encodeURIComponent(value);
  });
  const q = remoteQuerySchema.parse(query);
  const search = new URLSearchParams(q).toString();
  return search ? `${path}?${search}` : path;
}

/** Validate a command body against the operation (cloud side, before persisting it). */
export function validateRemoteBody(operation: RemoteOperation, body: unknown): { ok: true; body: unknown } | { ok: false; message: string } {
  if (body !== undefined && JSON.stringify(body).length > REMOTE_LIMITS.commandBodyBytes) return { ok: false, message: 'Request body too large' };
  if (!operation.body) return body === undefined || body === null || (typeof body === 'object' && Object.keys(body as object).length === 0) ? { ok: true, body: undefined } : { ok: false, message: 'This operation takes no body' };
  const parsed = operation.body.safeParse(body ?? {});
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid request body' };
  // Forward what the user sent (not Zod's output with defaults), so the node's route applies its own defaults.
  return { ok: true, body: body ?? {} };
}
