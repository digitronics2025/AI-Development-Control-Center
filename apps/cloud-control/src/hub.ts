import { DurableObject } from 'cloudflare:workers';
import {
  frame,
  parseNodeFrame,
  REMOTE_LIMITS,
  REMOTE_MIN_PROTOCOL_VERSION,
  REMOTE_PROTOCOL_VERSION,
  type CloudCommandView,
  type CloudFrame,
  type NodeFrame,
  type RemoteCommand,
} from '@acc/shared';
import type { Env } from './env.js';
import { log, nowIso } from './http.js';
import { CloudStore, commandFromRow, commandView } from './store.js';

/**
 * The realtime hub (docs/systems/cloud-control.md §Hub). One instance per
 * workspace holds every browser socket and every node socket, using the
 * WebSocket Hibernation API so idle connections cost nothing. It is not the
 * source of truth: D1 is. A missed frame is repaired by the node's reconnect
 * sync and the browser's refetch.
 */

type Attachment =
  | { kind: 'node'; nodeId: string; protocol: number; lastTouch: number }
  | { kind: 'browser'; user: string; logs: string[]; terminals: string[] };

interface RpcWaiter {
  nodeId: string;
  chunks: string[];
  meta: { httpStatus: number; contentType: string; encoding: 'utf8' | 'base64' } | null;
  resolve: (reply: RpcReply) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RpcReply {
  httpStatus: number;
  contentType: string;
  text: string;
  encoding: 'utf8' | 'base64';
}

export interface CommandWait {
  status: CloudCommandView['status'];
  command: CloudCommandView;
  /** The node's answer when it finished within the wait. */
  outcome?: { httpStatus: number; body: unknown };
  error?: { code: string; message: string };
}

/** Heartbeats are written to D1 at most this often per node. */
const TOUCH_EVERY_MS = 60_000;
/** Close node sockets older than this so every connection is re-authenticated regularly. */
const MAX_NODE_SOCKET_AGE_MS = 12 * 60 * 60_000;

export class WorkspaceHub extends DurableObject<Env> {
  private readonly store: CloudStore;
  private readonly rpcWaiters = new Map<string, RpcWaiter>();
  private readonly commandWaiters = new Map<string, Array<(w: CommandWait) => void>>();
  /** Frames from one node are handled in order (D1 calls would otherwise interleave). */
  private readonly nodeQueues = new Map<string, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new CloudStore(env.DB);
    // Browsers ping to keep proxies happy; answered without waking the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  // ----- sockets --------------------------------------------------------------------

  private sockets(tag: string): WebSocket[] {
    return this.ctx.getWebSockets(tag);
  }

  private attachment(ws: WebSocket): Attachment | null {
    return (ws.deserializeAttachment() as Attachment | null) ?? null;
  }

  private nodeSocket(nodeId: string): WebSocket | null {
    return this.sockets(`node:${nodeId}`).find((ws) => ws.readyState === WebSocket.OPEN) ?? null;
  }

  isNodeConnected(nodeId: string): boolean {
    return this.nodeSocket(nodeId) !== null;
  }

  connectedNodes(): string[] {
    return this.sockets('node')
      .map((ws) => this.attachment(ws))
      .filter((a): a is Extract<Attachment, { kind: 'node' }> => a?.kind === 'node')
      .map((a) => a.nodeId);
  }

  private sendNode(nodeId: string, message: Omit<CloudFrame, 'v' | 'id' | 'at'>): boolean {
    const ws = this.nodeSocket(nodeId);
    if (!ws) return false;
    try {
      ws.send(JSON.stringify(frame(message as { type: string; payload: unknown })));
      return true;
    } catch {
      return false;
    }
  }

  /** Relayed to every browser; the client keeps what belongs to the node it shows. */
  broadcast(message: Record<string, unknown>, nodeId?: string): void {
    const text = JSON.stringify(nodeId ? { ...message, nodeId } : message);
    if (text.length > REMOTE_LIMITS.frameBytes) return;
    for (const ws of this.sockets('browser')) {
      if (message.type === 'logs') {
        const a = this.attachment(ws);
        if (a?.kind !== 'browser' || !a.logs.includes(String(message.executionId))) continue;
      }
      if (message.type === 'terminal.output') {
        const a = this.attachment(ws);
        if (a?.kind !== 'browser' || !a.terminals.includes(String(message.terminalId))) continue;
      }
      try {
        ws.send(text);
      } catch {
        /* closing socket */
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/connect/node') return this.acceptNode(request);
    if (url.pathname === '/connect/browser') return this.acceptBrowser(request);
    return new Response('Not found', { status: 404 });
  }

  private async acceptNode(request: Request): Promise<Response> {
    const nodeId = request.headers.get('x-acc-node-id');
    const protocol = Number(request.headers.get('x-acc-protocol') ?? '0');
    if (!nodeId || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Bad request', { status: 400 });
    // One live socket per node: a reconnect replaces the old one.
    for (const old of this.sockets(`node:${nodeId}`)) old.close(4000, 'replaced by a newer connection');
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ['node', `node:${nodeId}`]);
    server.serializeAttachment({ kind: 'node', nodeId, protocol, lastTouch: 0 } satisfies Attachment);
    await this.alarmSoon();
    return new Response(null, { status: 101, webSocket: client });
  }

  private acceptBrowser(request: Request): Response {
    const user = request.headers.get('x-acc-user');
    if (!user || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Bad request', { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, ['browser']);
    server.serializeAttachment({ kind: 'browser', user, logs: [], terminals: [] } satisfies Attachment);
    server.send(JSON.stringify({ type: 'hello', version: 'cloud', serverTime: nowIso(), startedAt: nowIso() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    const a = this.attachment(ws);
    if (!a) return;
    if (a.kind === 'node') {
      const previous = this.nodeQueues.get(a.nodeId) ?? Promise.resolve();
      const next = previous.then(() => this.onNodeMessage(ws, this.attachment(ws) as Extract<Attachment, { kind: 'node' }>, message));
      this.nodeQueues.set(a.nodeId, next);
      await next;
      if (this.nodeQueues.get(a.nodeId) === next) this.nodeQueues.delete(a.nodeId);
    }
    else this.onBrowserMessage(ws, a, message);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const a = this.attachment(ws);
    if (a?.kind === 'node') log('info', 'node.socket.closed', { nodeId: a.nodeId, code, reason: reason.slice(0, 120) });
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closing');
    } catch {
      /* already closed */
    }
    if (a?.kind === 'node') await this.nodeGone(a.nodeId, ws);
    if (a?.kind === 'browser') this.pushSubscriptions();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const a = this.attachment(ws);
    if (a?.kind === 'node') await this.nodeGone(a.nodeId, ws);
  }

  private async nodeGone(nodeId: string, ws: WebSocket): Promise<void> {
    // Another socket for the same node may already have replaced this one.
    if (this.sockets(`node:${nodeId}`).some((s) => s !== ws && s.readyState === WebSocket.OPEN)) return;
    await this.store.markDisconnected(nodeId);
    for (const [id, w] of this.rpcWaiters) {
      if (w.nodeId !== nodeId) continue;
      clearTimeout(w.timer);
      this.rpcWaiters.delete(id);
      w.resolve({ httpStatus: 503, contentType: 'application/json', text: JSON.stringify({ error: { code: 'NODE_OFFLINE', message: 'The node disconnected before it answered.' } }), encoding: 'utf8' });
    }
    await this.broadcastNode(nodeId);
    log('info', 'node.disconnected', { nodeId });
  }

  private async broadcastNode(nodeId: string): Promise<void> {
    const view = await this.store.nodeView(nodeId);
    if (view) this.broadcast({ type: 'remote.node', node: view });
  }

  // ----- browsers ------------------------------------------------------------------------

  private onBrowserMessage(ws: WebSocket, a: Extract<Attachment, { kind: 'browser' }>, text: string): void {
    if (text.length > 70 * 1024) return;
    let m: { type?: string; executionId?: unknown; terminalId?: unknown; data?: unknown; cols?: unknown; rows?: unknown; nodeId?: unknown };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    const id = (v: unknown) => (typeof v === 'string' && v.length <= 200 ? v : null);
    const next = { ...a };
    switch (m.type) {
      case 'subscribeLogs':
        if (id(m.executionId) && next.logs.length < 50 && !next.logs.includes(m.executionId as string)) next.logs = [...next.logs, m.executionId as string];
        break;
      case 'unsubscribeLogs':
        next.logs = next.logs.filter((x) => x !== m.executionId);
        break;
      case 'subscribeTerminal':
        if (id(m.terminalId) && next.terminals.length < 20 && !next.terminals.includes(m.terminalId as string)) next.terminals = [...next.terminals, m.terminalId as string];
        break;
      case 'unsubscribeTerminal':
        next.terminals = next.terminals.filter((x) => x !== m.terminalId);
        break;
      case 'terminal.input':
      case 'terminal.resize': {
        // Only into a terminal this browser shows; the node enforces the remote grant and classifies every line.
        const terminalId = id(m.terminalId);
        const nodeId = id(m.nodeId);
        if (!terminalId || !nodeId || !a.terminals.includes(terminalId)) return;
        if (m.type === 'terminal.input' && typeof m.data === 'string' && m.data.length <= 64 * 1024) this.sendNode(nodeId, { type: 'terminal.input', payload: { terminalId, data: m.data } });
        if (m.type === 'terminal.resize') this.sendNode(nodeId, { type: 'terminal.resize', payload: { terminalId, cols: Number(m.cols), rows: Number(m.rows) } });
        return;
      }
      default:
        return;
    }
    ws.serializeAttachment(next);
    this.pushSubscriptions();
  }

  /** Tell every node which executions and terminals someone is watching. */
  private pushSubscriptions(): void {
    const logs = new Set<string>();
    const terminals = new Set<string>();
    for (const ws of this.sockets('browser')) {
      const a = this.attachment(ws);
      if (a?.kind !== 'browser') continue;
      a.logs.forEach((x) => logs.add(x));
      a.terminals.forEach((x) => terminals.add(x));
    }
    for (const nodeId of this.connectedNodes()) this.sendNode(nodeId, { type: 'subscriptions', payload: { logs: [...logs].slice(0, 100), terminals: [...terminals].slice(0, 20) } });
  }

  // ----- nodes ------------------------------------------------------------------------------

  private async onNodeMessage(ws: WebSocket, a: Extract<Attachment, { kind: 'node' }>, text: string): Promise<void> {
    const parsed = parseNodeFrame(text);
    if (!parsed.ok) {
      if (parsed.code === 'NODE_UPDATE_REQUIRED') ws.close(4026, parsed.message.slice(0, 120));
      log('warn', 'node.frame.rejected', { nodeId: a.nodeId, code: parsed.code });
      return;
    }
    const f = parsed.frame;
    const nodeId = a.nodeId;
    try {
      await this.handleNodeFrame(ws, a, f);
    } catch (error) {
      log('error', 'node.frame.failed', { nodeId, type: f.type, message: (error as Error).message });
    }
  }

  private async handleNodeFrame(ws: WebSocket, a: Extract<Attachment, { kind: 'node' }>, f: NodeFrame): Promise<void> {
    const nodeId = a.nodeId;
    switch (f.type) {
      case 'node.hello': {
        if (f.payload.protocolVersion < REMOTE_MIN_PROTOCOL_VERSION) {
          ws.close(4026, `Update required: protocol ${REMOTE_MIN_PROTOCOL_VERSION} or newer`);
          return;
        }
        await this.store.markConnected(nodeId, { os: f.payload.os, appVersion: f.payload.appVersion, protocolVersion: f.payload.protocolVersion });
        const ackedSeq = await this.store.lastEventSeq(nodeId);
        this.sendNode(nodeId, { type: 'session.welcome', payload: { nodeId, protocolVersion: REMOTE_PROTOCOL_VERSION, minProtocolVersion: REMOTE_MIN_PROTOCOL_VERSION, ackedSeq, serverTime: nowIso() } });
        this.pushSubscriptions();
        await this.broadcastNode(nodeId);
        log('info', 'node.connected', { nodeId, appVersion: f.payload.appVersion });
        return;
      }
      case 'node.capabilities':
        await this.store.setCapabilities(nodeId, f.payload);
        await this.broadcastNode(nodeId);
        return;
      case 'node.snapshot':
        await this.store.setRepositories(nodeId, f.payload.repositories);
        await this.broadcastNode(nodeId);
        return;
      case 'node.heartbeat': {
        const now = Date.now();
        if (now - a.lastTouch > TOUCH_EVERY_MS) {
          ws.serializeAttachment({ ...a, lastTouch: now });
          // A revocation written straight to D1 (emergency CLI) ends the live socket within a minute.
          if (!(await this.store.touch(nodeId))) {
            this.sendNode(nodeId, { type: 'node.revoked', payload: { reason: 'revoked' } });
            ws.close(4003, 'revoked');
          }
        }
        return;
      }
      case 'event.batch': {
        const { fresh, ackedSeq } = await this.store.ingest(nodeId, f.payload.events);
        this.sendNode(nodeId, { type: 'sync.ack', payload: { upToSeq: ackedSeq } });
        for (const e of fresh) if (e.kind === 'message') this.broadcast(e.payload as Record<string, unknown>, nodeId);
        return;
      }
      case 'event.live': {
        const m = f.payload.message as Record<string, unknown> | null;
        if (m && typeof m.type === 'string') this.broadcast(m, nodeId);
        return;
      }
      case 'sync.request': {
        const rows = await this.store.deliverable(nodeId);
        for (const row of rows) {
          if (this.sendNode(nodeId, { type: 'command.available', payload: { command: commandFromRow(row) } }) && row.status === 'pending') await this.store.transition(row.id, nodeId, 'delivered');
        }
        this.sendNode(nodeId, { type: 'sync.complete', payload: { pending: rows.length } });
        return;
      }
      case 'command.claim': {
        const row = await this.store.transition(f.payload.commandId, nodeId, 'claimed');
        if (row) this.broadcast({ type: 'remote.command', command: commandView(row) });
        return;
      }
      case 'command.result': {
        const { commandId, outcome } = f.payload;
        const to = outcome.httpStatus < 400 ? 'succeeded' : 'failed';
        const row = await this.store.transition(commandId, nodeId, to, { resultStatus: outcome.httpStatus, resultBody: outcome.body });
        // Acknowledge even a duplicate: the node stops replaying it.
        this.sendNode(nodeId, { type: 'command.ack', payload: { commandId } });
        if (!row) return;
        await this.afterCommand(row.id, row.op, to, outcome.body);
        const view = commandView(row);
        this.broadcast({ type: 'remote.command', command: view });
        this.resolveCommand(commandId, { status: view.status, command: view, outcome });
        return;
      }
      case 'command.failed': {
        const { commandId, code, message, status } = f.payload;
        const row = await this.store.transition(commandId, nodeId, status, { errorCode: code, errorMessage: message });
        this.sendNode(nodeId, { type: 'command.ack', payload: { commandId } });
        if (!row) return;
        await this.afterCommand(row.id, row.op, 'failed', null);
        const view = commandView(row);
        this.broadcast({ type: 'remote.command', command: view });
        this.resolveCommand(commandId, { status: view.status, command: view, error: { code, message } });
        return;
      }
      case 'rpc.response': {
        const p = f.payload;
        const w = this.rpcWaiters.get(p.requestId);
        if (!w || w.nodeId !== nodeId) return;
        w.meta ??= { httpStatus: p.httpStatus, contentType: p.contentType, encoding: p.encoding };
        w.chunks[p.index] = p.chunk;
        const received = w.chunks.filter((c) => c !== undefined);
        const size = received.reduce((n, c) => n + c.length, 0);
        if (size > REMOTE_LIMITS.rpcResponseBytes) {
          clearTimeout(w.timer);
          this.rpcWaiters.delete(p.requestId);
          w.resolve({ httpStatus: 413, contentType: 'application/json', text: JSON.stringify({ error: { code: 'REMOTE_INVALID', message: 'The answer is too large to relay.' } }), encoding: 'utf8' });
          return;
        }
        if (received.length === p.total) {
          clearTimeout(w.timer);
          this.rpcWaiters.delete(p.requestId);
          w.resolve({ ...w.meta, text: w.chunks.join('') });
        }
        return;
      }
      case 'artifact.manifest':
        await this.store.upsertManifest(nodeId, f.payload);
        return;
      case 'log.chunk.manifest':
        // The chunk itself arrives by HTTP upload, which records it; the frame is informational.
        return;
    }
  }

  /** Lease bookkeeping once a command ends. */
  private async afterCommand(commandId: string, op: string, status: 'succeeded' | 'failed', body: unknown): Promise<void> {
    if (op !== 'task.create' && op !== 'task.start') return;
    const taskId = (body as { id?: unknown } | null)?.id;
    if (status === 'succeeded' && typeof taskId === 'string') {
      await this.store.bindLeaseTask(commandId, taskId);
      await this.store.setCommandTask(commandId, taskId);
    } else {
      await this.store.releaseLeaseForCommand(commandId);
    }
  }

  private resolveCommand(commandId: string, w: CommandWait): void {
    const waiters = this.commandWaiters.get(commandId);
    this.commandWaiters.delete(commandId);
    for (const resolve of waiters ?? []) resolve(w);
  }

  // ----- RPC called by the Worker --------------------------------------------------------------

  /** A live read from one node. Resolves with the node's answer, or 503/504 when it cannot. */
  async rpc(nodeId: string, request: { op: string; params: Record<string, string>; query: Record<string, string>; body?: unknown }, timeoutMs = 25_000): Promise<RpcReply> {
    const requestId = crypto.randomUUID();
    return new Promise<RpcReply>((resolve) => {
      const timer = setTimeout(() => {
        this.rpcWaiters.delete(requestId);
        resolve({ httpStatus: 504, contentType: 'application/json', text: JSON.stringify({ error: { code: 'REMOTE_TIMEOUT', message: 'The node did not answer in time.' } }), encoding: 'utf8' });
      }, timeoutMs);
      this.rpcWaiters.set(requestId, { nodeId, chunks: [], meta: null, resolve, timer });
      const sent = this.sendNode(nodeId, { type: 'rpc.request', payload: { requestId, op: request.op, params: request.params, query: request.query, ...(request.body !== undefined ? { body: request.body } : {}), deadline: new Date(Date.now() + timeoutMs).toISOString() } });
      if (!sent) {
        clearTimeout(timer);
        this.rpcWaiters.delete(requestId);
        resolve({ httpStatus: 503, contentType: 'application/json', text: JSON.stringify({ error: { code: 'NODE_OFFLINE', message: 'The node is offline.' } }), encoding: 'utf8' });
      }
    });
  }

  /**
   * Deliver a command that is already stored in D1, then wait briefly for its
   * outcome. Delivery here is only a fast path: the node also fetches pending
   * commands after every reconnect.
   */
  async deliver(command: RemoteCommand, waitMs = 20_000): Promise<CommandWait> {
    const sent = this.sendNode(command.nodeId, { type: 'command.available', payload: { command } });
    if (sent) await this.store.transition(command.id, command.nodeId, 'delivered');
    const current = await this.store.command(command.id);
    const pending = (): CommandWait => ({ status: current?.status ?? 'pending', command: commandView(current!) });
    if (!sent || waitMs <= 0) return pending();
    return new Promise<CommandWait>((resolve) => {
      const timer = setTimeout(() => {
        const list = this.commandWaiters.get(command.id)?.filter((r) => r !== done) ?? [];
        if (list.length) this.commandWaiters.set(command.id, list);
        else this.commandWaiters.delete(command.id);
        void this.store.command(command.id).then((row) => resolve({ status: row?.status ?? 'pending', command: commandView(row ?? current!) }));
      }, waitMs);
      const done = (w: CommandWait) => {
        clearTimeout(timer);
        resolve(w);
      };
      this.commandWaiters.set(command.id, [...(this.commandWaiters.get(command.id) ?? []), done]);
    });
  }

  async revoke(nodeId: string): Promise<void> {
    this.sendNode(nodeId, { type: 'node.revoked', payload: { reason: 'revoked' } });
    for (const ws of this.sockets(`node:${nodeId}`)) ws.close(4003, 'revoked');
    await this.broadcastNode(nodeId);
  }

  /** Ask the node to rotate its key (it signs with the new key; the old sessions die). */
  requestRotation(nodeId: string, by: string): boolean {
    return this.sendNode(nodeId, { type: 'node.rotate', payload: { requestedBy: by } });
  }

  /** The key changed: close the socket so the node reconnects with a session from the new key. */
  keyRotated(nodeId: string): void {
    for (const ws of this.sockets(`node:${nodeId}`)) ws.close(4001, 'key rotated');
  }

  async announceNode(nodeId: string): Promise<void> {
    await this.broadcastNode(nodeId);
  }

  // ----- housekeeping --------------------------------------------------------------------------

  private async alarmSoon(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 60 * 60_000);
  }

  /** Hourly: force old node sockets to re-authenticate. Keeps no state of its own. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.sockets('node')) {
      const a = this.attachment(ws);
      if (a?.kind !== 'node') continue;
      const connectedAt = (await this.store.nodeView(a.nodeId))?.connectedAt;
      if (connectedAt && now - Date.parse(connectedAt) > MAX_NODE_SOCKET_AGE_MS) ws.close(4002, 'session renewal');
    }
    if (this.sockets('node').length) await this.ctx.storage.setAlarm(now + 60 * 60_000);
  }
}
