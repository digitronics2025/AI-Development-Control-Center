import {
  approvalBindingHash,
  commandPayloadHash,
  localPathFor,
  remoteCommandSchema,
  remoteOperation,
  REMOTE_LIMITS,
  type CommandOutcome,
  type CommandPrecondition,
  type RemoteCommand,
  type RemoteErrorCode,
  type RemoteOperation,
} from '@acc/shared';
import type { EgressSanitizer } from './egress.js';
import { guardRemoteCommand, type GuardContext } from './guards.js';
import type { RemoteConfig, RemoteStore } from './store.js';

/** The in-process HTTP surface (Fastify `inject`): the same routes, validation and error mapping as a local request. */
export interface LocalHttp {
  inject(request: { method: string; url: string; headers: Record<string, string>; payload?: string }): Promise<{ statusCode: number; headers: Record<string, unknown>; rawPayload: Buffer }>;
}

export type CommandReport =
  | { kind: 'result'; commandId: string; outcome: CommandOutcome; replayed: boolean }
  | { kind: 'failed'; commandId: string; code: RemoteErrorCode | string; message: string; status: 'failed' | 'rejected' | 'expired' };

export interface RpcRequest {
  requestId: string;
  op: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body?: unknown;
}

export interface RpcReply {
  httpStatus: number;
  contentType: string;
  text: string;
  encoding: 'utf8' | 'base64';
}

export interface DispatcherDeps {
  store: RemoteStore;
  http: () => LocalHttp | null;
  /** The local API token: used only on this in-process request, never sent anywhere. */
  token: string;
  config: () => RemoteConfig | null;
  egress: EgressSanitizer;
  guard: () => GuardContext;
  taskVersion: (taskId: string) => number | null;
  approvalView: (approvalId: string) => Parameters<typeof approvalBindingHash>[0] | null;
  /** Artifact type, for the sync policy on artifact reads. */
  artifactPolicy: (artifactId: string) => 'safe_sync' | 'local_only' | 'user_shared' | null;
  /** A terminal the cloud opened: the service starts its grant. */
  onTerminalOpened?: (terminalId: string) => void;
  now?: () => number;
}

/** A command result larger than this is replaced by a note; the browser refetches the entity. */
const MAX_RESULT_CHARS = 512 * 1024;

class Refusal extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
    readonly status: 'failed' | 'rejected' | 'expired' = 'rejected',
  ) {
    super(message);
  }
}

/**
 * Executes what the cloud asks, exactly once and only through the typed
 * operation catalog (docs/systems/remote-node.md §Commands). The receipt is
 * written to SQLite before any check or execution, so a duplicate — resent
 * after a reconnect, or delivered twice — returns the first outcome instead
 * of running again.
 */
export class RemoteDispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Returns what to report to the cloud, or null when there is nothing to report yet (the first delivery is still running). */
  async executeCommand(raw: unknown, hooks: { admitted?: (commandId: string) => void } = {}): Promise<CommandReport | null> {
    const parsed = remoteCommandSchema.safeParse(raw);
    const id = (raw as { id?: unknown } | null)?.id;
    if (!parsed.success) {
      return typeof id === 'string' && id.length <= 200 ? { kind: 'failed', commandId: id, code: 'REMOTE_INVALID', message: parsed.error.issues[0]?.message ?? 'Invalid command', status: 'rejected' } : null;
    }
    const command = parsed.data;
    const previous = this.deps.store.receipt(command.id);
    if (previous) return previous.status === 'running' ? null : this.replay(previous.commandId);
    if (!this.deps.store.recordReceipt(command.id, command.op, command.payloadHash)) return null;

    try {
      const operation = await this.admit(command);
      hooks.admitted?.(command.id);
      const outcome = await this.run(operation, command);
      this.deps.store.finishReceipt(command.id, outcome.httpStatus < 400 ? 'succeeded' : 'failed', { httpStatus: outcome.httpStatus, result: outcome.body, errorCode: null });
      if (operation.op === 'terminal.open' && outcome.httpStatus < 300) {
        const terminalId = (outcome.body as { id?: unknown } | null)?.id;
        if (typeof terminalId === 'string') this.deps.onTerminalOpened?.(terminalId);
      }
      return { kind: 'result', commandId: command.id, outcome, replayed: false };
    } catch (error) {
      const refusal = error instanceof Refusal ? error : new Refusal('REMOTE_UNAVAILABLE', `The node could not run the command: ${(error as Error).message}`, 'failed');
      this.deps.store.finishReceipt(command.id, refusal.status === 'failed' ? 'failed' : 'rejected', { httpStatus: null, result: { message: refusal.message, status: refusal.status }, errorCode: refusal.code });
      return { kind: 'failed', commandId: command.id, code: refusal.code, message: refusal.message, status: refusal.status };
    }
  }

  /** The stored outcome of a finished command, for a duplicate delivery or a replay after reconnect. */
  replay(commandId: string): CommandReport | null {
    const r = this.deps.store.receipt(commandId);
    if (!r || r.status === 'running') return null;
    if (r.errorCode) {
      const detail = (r.result as { message?: string; status?: 'failed' | 'rejected' | 'expired' } | null) ?? {};
      const status = r.status === 'interrupted' ? 'failed' : (detail.status ?? 'rejected');
      const message = r.status === 'interrupted' ? 'The node restarted while this command ran; its outcome is unknown and it was not run again.' : (detail.message ?? r.errorCode);
      return { kind: 'failed', commandId, code: r.errorCode, message, status };
    }
    return { kind: 'result', commandId, outcome: { httpStatus: r.httpStatus ?? 500, body: r.result }, replayed: true };
  }

  private async admit(command: RemoteCommand): Promise<RemoteOperation> {
    const config = this.deps.config();
    if (!config || !config.enabled) throw new Refusal('REMOTE_FORBIDDEN', 'Remote control is turned off on this node.');
    if (command.nodeId !== config.nodeId) throw new Refusal('REMOTE_FORBIDDEN', 'This command is addressed to another node.');
    if ((await commandPayloadHash(command)) !== command.payloadHash) throw new Refusal('REMOTE_INVALID', 'The command does not match its payload hash.');
    if (Date.parse(command.expiresAt) <= this.now()) throw new Refusal('REMOTE_COMMAND_EXPIRED', 'The command expired before it reached this node.', 'expired');
    const operation = remoteOperation(command.op);
    if (!operation || operation.kind !== 'command') throw new Refusal('REMOTE_INVALID', `Unknown remote operation: ${command.op}`);
    this.checkGate(operation, config);
    const guard = guardRemoteCommand(operation.op, command.params, command.body, this.deps.guard());
    if (!guard.ok) throw new Refusal('REMOTE_FORBIDDEN', guard.message);
    if (command.precondition) await this.checkPrecondition(command.precondition, operation, command.params);
    return operation;
  }

  private checkGate(operation: RemoteOperation, config: RemoteConfig): void {
    if (operation.gate === 'terminals' && !config.remoteTerminals) throw new Refusal('REMOTE_FORBIDDEN', 'Remote terminals are turned off on this node. Turn them on from this machine: Settings → Remote access.');
    if (operation.gate === 'tools' && !config.remoteTools) throw new Refusal('REMOTE_FORBIDDEN', 'Remote tool calls are turned off on this node. Turn them on from this machine: Settings → Remote access.');
  }

  private async checkPrecondition(p: CommandPrecondition, operation: RemoteOperation, params: Record<string, string>): Promise<void> {
    if (p.kind !== operation.precondition) throw new Refusal('REMOTE_INVALID', 'The command carries the wrong kind of precondition.');
    if (p.kind === 'taskVersion') {
      if (params.id !== undefined && params.id !== p.taskId) throw new Refusal('REMOTE_INVALID', 'The precondition names another task.');
      const version = this.deps.taskVersion(p.taskId);
      if (version === null) return; // the route answers NOT_FOUND
      if (version !== p.version) throw new Refusal('REMOTE_CONFLICT', `The task changed since you saw it (version ${p.version}, now ${version}). Refresh and try again.`);
      return;
    }
    if (params.id !== p.approvalId) throw new Refusal('REMOTE_INVALID', 'The precondition names another approval.');
    const view = this.deps.approvalView(p.approvalId);
    if (!view) return; // the route answers NOT_FOUND
    if ((await approvalBindingHash(view)) !== p.hash) throw new Refusal('REMOTE_CONFLICT', 'This approval is not the one you saw. Refresh and decide again.');
  }

  private async run(operation: RemoteOperation, command: RemoteCommand): Promise<CommandOutcome> {
    const response = await this.inject(operation, command.params, command.query, command.body, command.id);
    const text = response.rawPayload.toString('utf8');
    let body: unknown = null;
    if (text) {
      try {
        body = this.deps.egress.response(JSON.parse(text));
      } catch {
        body = { message: this.deps.egress.scrubText(text.slice(0, 2000)) };
      }
    }
    if (JSON.stringify(body ?? null).length > MAX_RESULT_CHARS) body = { note: 'The result is too large to relay; the view refreshes from the node.' };
    return { httpStatus: response.statusCode, body };
  }

  private async inject(operation: RemoteOperation, params: Record<string, string>, query: Record<string, string>, body: unknown, requestId: string) {
    const http = this.deps.http();
    if (!http) throw new Refusal('REMOTE_UNAVAILABLE', 'The node is still starting.', 'failed');
    let url: string;
    try {
      url = localPathFor(operation, params, query);
    } catch (error) {
      throw new Refusal('REMOTE_INVALID', (error as Error).message);
    }
    const hasBody = operation.method !== 'GET' && operation.method !== 'DELETE';
    return http.inject({
      method: operation.method,
      url,
      headers: {
        host: '127.0.0.1',
        authorization: `Bearer ${this.deps.token}`,
        'x-acc-remote-request': requestId,
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(hasBody ? { payload: JSON.stringify(body ?? {}) } : {}),
    });
  }

  /** Answer a live read. Reads are not durable and not recorded; they pass the same catalog, gates and egress policy. */
  async executeRpc(request: RpcRequest): Promise<RpcReply> {
    const error = (httpStatus: number, code: string, message: string): RpcReply => ({ httpStatus, contentType: 'application/json', text: JSON.stringify({ error: { code, message } }), encoding: 'utf8' });
    const config = this.deps.config();
    if (!config?.enabled) return error(403, 'REMOTE_FORBIDDEN', 'Remote control is turned off on this node.');
    const operation = remoteOperation(request.op);
    if (!operation || operation.kind !== 'read') return error(400, 'REMOTE_INVALID', `Unknown remote read: ${request.op}`);
    try {
      this.checkGate(operation, config);
    } catch (refusal) {
      return error(403, 'REMOTE_FORBIDDEN', (refusal as Error).message);
    }
    if (operation.op === 'artifact.content' || operation.op === 'artifact.download') {
      const policy = this.deps.artifactPolicy(request.params.id ?? '');
      if (policy === 'local_only') return error(403, 'REMOTE_FORBIDDEN', 'This artifact stays on its node (diffs, environment and raw tool data are local-only). Open it on that machine, or share it from there.');
    }
    let response;
    try {
      response = await this.inject(operation, request.params, request.query, request.body, request.requestId);
    } catch (refusal) {
      const r = refusal instanceof Refusal ? refusal : new Refusal('REMOTE_UNAVAILABLE', (refusal as Error).message);
      return error(r.code === 'REMOTE_INVALID' ? 400 : 503, r.code, r.message);
    }
    const contentType = String(response.headers['content-type'] ?? 'application/json');
    if (operation.binary) {
      if (response.rawPayload.length > REMOTE_LIMITS.rpcResponseBytes * 0.7) return error(413, 'REMOTE_INVALID', 'This file is too large to open remotely.');
      // Text downloads (CSV exports, text artifacts) are scrubbed like everything else; true binaries were redacted when written.
      if (/^(text\/|application\/(json|x-ndjson|csv))/.test(contentType)) {
        return { httpStatus: response.statusCode, contentType, text: Buffer.from(this.deps.egress.scrubText(response.rawPayload.toString('utf8')), 'utf8').toString('base64'), encoding: 'base64' };
      }
      return { httpStatus: response.statusCode, contentType, text: response.rawPayload.toString('base64'), encoding: 'base64' };
    }
    const text = response.rawPayload.toString('utf8');
    let out: string;
    try {
      out = JSON.stringify(this.deps.egress.response(JSON.parse(text)));
    } catch {
      out = this.deps.egress.scrubText(text);
    }
    if (out.length > REMOTE_LIMITS.rpcResponseBytes) return error(413, 'REMOTE_INVALID', 'The answer is too large to relay. Narrow the request.');
    return { httpStatus: response.statusCode, contentType: contentType.startsWith('application/json') ? 'application/json' : contentType, text: out, encoding: 'utf8' };
  }
}
