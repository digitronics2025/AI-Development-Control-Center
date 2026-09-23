import { randomBytes, webcrypto } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  commandPayloadHash,
  frame,
  parseNodeFrame,
  sessionProofMessage,
  REMOTE_PROTOCOL_VERSION,
  type NodeFrame,
  type PublicJwk,
  type RemoteCommand,
} from '@acc/shared';

/**
 * A minimal in-process stand-in for the cloud relay (the real one is the
 * Worker in apps/cloud-control, tested against the Workers runtime). It
 * speaks the same wire protocol so the node can be exercised without
 * Cloudflare: pairing, challenge-response, sessions, the WebSocket and its
 * frames — plus switches to drop connections and revoke.
 */
export class FakeRelay {
  readonly tokens = new Set<string>();
  readonly nodes = new Map<string, { publicKey: PublicJwk; revoked: boolean; label: string }>();
  readonly frames: NodeFrame[] = [];
  readonly events: Array<{ seq: number; kind: string; payload: any }> = [];
  ackedSeq = 0;
  /** Commands the relay will deliver on `sync.request` (and when sent explicitly). */
  readonly pending = new Map<string, RemoteCommand>();
  readonly results = new Map<string, NodeFrame[]>();
  /** Answer a batch with a `sync.ack` (switch off to simulate lost acknowledgements). */
  ackBatches = true;
  /** Answer results with a `command.ack`. */
  ackResults = true;
  minProtocolVersion = 1;
  connections = 0;
  private readonly nonces = new Map<string, { nodeId: string; expires: number }>();
  private readonly sessions = new Map<string, string>();
  private readonly sockets = new Set<WebSocket>();
  private readonly rpcWaiters = new Map<string, { chunks: string[]; resolve: (v: { httpStatus: number; body: any }) => void }>();
  private server!: Server;
  private wss!: WebSocketServer;
  url = '';

  async start(port = 0): Promise<this> {
    this.stopped = false;
    this.wss = new WebSocketServer({ noServer: true });
    this.server = createServer((req, res) => void this.http(req, res));
    this.server.on('upgrade', (req, socket, head) => {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const nodeId = this.sessions.get(token);
      if (req.url !== '/node/v1/connect' || !nodeId || this.nodes.get(nodeId)?.revoked) {
        socket.write(`HTTP/1.1 ${nodeId ? 403 : 401} Refused\r\nconnection: close\r\n\r\n`);
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, nodeId));
    });
    await new Promise<void>((resolve) => this.server.listen(port, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  private stopped = false;

  /** Come back on the same address, keeping everything the relay stored (a cloud outage that ends). */
  async restart(): Promise<void> {
    const port = Number(new URL(this.url).port);
    await this.stop();
    await this.start(port);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const s of this.sockets) s.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  newPairingToken(): string {
    const token = `accpair_${randomBytes(32).toString('base64url')}`;
    this.tokens.add(token);
    return token;
  }

  dropConnections(): void {
    for (const s of this.sockets) s.terminate();
  }

  revoke(nodeId: string): void {
    this.nodes.get(nodeId)!.revoked = true;
    for (const s of this.sockets) s.close(4003, 'revoked');
  }

  get connected(): boolean {
    return this.sockets.size > 0;
  }

  async command(nodeId: string, op: string, params: Record<string, string>, body: unknown, extra: Partial<RemoteCommand> = {}): Promise<RemoteCommand> {
    const base = {
      id: `cmd-${randomBytes(6).toString('hex')}`,
      nodeId,
      op,
      params,
      query: {},
      body,
      idempotencyKey: `idem-${randomBytes(6).toString('hex')}`,
      precondition: null,
      createdBy: 'tester@example.com',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
      ...extra,
    };
    const payloadHash = extra.payloadHash ?? (await commandPayloadHash(base));
    return { ...base, payloadHash } as RemoteCommand;
  }

  deliver(command: RemoteCommand): void {
    this.pending.set(command.id, command);
    this.broadcast({ type: 'command.available', payload: { command } });
  }

  rpc(op: string, params: Record<string, string> = {}, query: Record<string, string> = {}): Promise<{ httpStatus: number; body: any }> {
    const requestId = `rpc-${randomBytes(6).toString('hex')}`;
    return new Promise((resolve) => {
      this.rpcWaiters.set(requestId, { chunks: [], resolve });
      this.broadcast({ type: 'rpc.request', payload: { requestId, op, params, query, deadline: new Date(Date.now() + 20_000).toISOString() } });
    });
  }

  send(message: { type: string; payload: unknown }): void {
    this.broadcast(message);
  }

  private broadcast(message: { type: string; payload: unknown }): void {
    const text = JSON.stringify(frame(message));
    for (const s of this.sockets) s.send(text);
  }

  private onSocket(ws: WebSocket, nodeId: string): void {
    this.connections++;
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.on('message', (data) => {
      const parsed = parseNodeFrame(data.toString());
      if (!parsed.ok) throw new Error(`Invalid frame from node: ${parsed.message}`);
      const f = parsed.frame;
      this.frames.push(f);
      const reply = (message: { type: string; payload: unknown }) => ws.send(JSON.stringify(frame(message)));
      switch (f.type) {
        case 'node.hello':
          reply({ type: 'session.welcome', payload: { nodeId, protocolVersion: REMOTE_PROTOCOL_VERSION, minProtocolVersion: this.minProtocolVersion, ackedSeq: this.ackedSeq, serverTime: new Date().toISOString() } });
          break;
        case 'event.batch': {
          for (const e of f.payload.events) if (e.seq > this.ackedSeq) this.events.push(e);
          const last = f.payload.events.at(-1)!.seq;
          if (this.ackBatches) {
            this.ackedSeq = Math.max(this.ackedSeq, last);
            reply({ type: 'sync.ack', payload: { upToSeq: this.ackedSeq } });
          }
          break;
        }
        case 'sync.request':
          for (const c of this.pending.values()) reply({ type: 'command.available', payload: { command: c } });
          reply({ type: 'sync.complete', payload: { pending: this.pending.size } });
          break;
        case 'command.claim':
          break;
        case 'command.result':
        case 'command.failed': {
          const id = f.payload.commandId;
          this.results.set(id, [...(this.results.get(id) ?? []), f]);
          this.pending.delete(id);
          if (this.ackResults) reply({ type: 'command.ack', payload: { commandId: id } });
          break;
        }
        case 'rpc.response': {
          const waiter = this.rpcWaiters.get(f.payload.requestId);
          if (!waiter) break;
          waiter.chunks[f.payload.index] = f.payload.chunk;
          if (waiter.chunks.filter((c) => c !== undefined).length === f.payload.total) {
            this.rpcWaiters.delete(f.payload.requestId);
            const text = waiter.chunks.join('');
            const body = f.payload.encoding === 'base64' ? Buffer.from(text, 'base64').toString('utf8') : text;
            let parsedBody: unknown = body;
            try {
              parsedBody = JSON.parse(body);
            } catch {
              /* text */
            }
            waiter.resolve({ httpStatus: f.payload.httpStatus, body: parsedBody });
          }
          break;
        }
        default:
          break;
      }
    });
  }

  private async http(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any = {};
    try {
      body = chunks.length && req.method === 'POST' ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      body = {};
    }
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const error = (status: number, code: string, message: string) => send(status, { error: { code, message } });
    const verify = async (publicKey: PublicJwk, message: string, signature: string) => {
      const key = await webcrypto.subtle.importKey('jwk', { ...publicKey, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(signature, 'base64url'), new TextEncoder().encode(message));
    };
    switch (req.url) {
      case '/node/v1/pair': {
        if (!this.tokens.delete(body.token)) return error(401, 'UNAUTHORIZED', 'Pairing code is invalid, used or expired');
        const nodeId = `node_${randomBytes(12).toString('base64url')}`;
        this.nodes.set(nodeId, { publicKey: body.publicKey, revoked: false, label: body.label });
        return send(201, { nodeId, label: body.label });
      }
      case '/node/v1/challenge': {
        const node = this.nodes.get(body.nodeId);
        if (!node) return error(404, 'NODE_NOT_FOUND', 'Unknown node');
        if (node.revoked) return error(403, 'NODE_REVOKED', 'Node revoked');
        const nonce = randomBytes(32).toString('base64url');
        this.nonces.set(nonce, { nodeId: body.nodeId, expires: Date.now() + 60_000 });
        return send(200, { nonce, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      }
      case '/node/v1/session': {
        const n = this.nonces.get(body.nonce);
        this.nonces.delete(body.nonce);
        const node = this.nodes.get(body.nodeId);
        if (!n || n.nodeId !== body.nodeId || !node) return error(401, 'UNAUTHORIZED', 'Challenge failed');
        if (node.revoked) return error(403, 'NODE_REVOKED', 'Node revoked');
        if (!(await verify(node.publicKey, sessionProofMessage('session', body.nodeId, body.nonce), body.signature))) return error(401, 'UNAUTHORIZED', 'Bad signature');
        const session = `sess_${randomBytes(32).toString('base64url')}`;
        this.sessions.set(session, body.nodeId);
        return send(200, { session, expiresAt: new Date(Date.now() + 600_000).toISOString(), protocolVersion: REMOTE_PROTOCOL_VERSION });
      }
      case '/node/v1/rotate': {
        const nodeId = this.sessions.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
        const n = this.nonces.get(body.nonce);
        this.nonces.delete(body.nonce);
        if (!nodeId || !n || n.nodeId !== nodeId) return error(401, 'UNAUTHORIZED', 'Rotation refused');
        if (!(await verify(body.publicKey, sessionProofMessage('rotate', nodeId, body.nonce), body.signature))) return error(401, 'UNAUTHORIZED', 'Bad signature');
        const node = this.nodes.get(nodeId)!;
        node.publicKey = body.publicKey;
        return send(200, { nodeId, label: node.label });
      }
      default:
        return error(404, 'NOT_FOUND', 'Not found');
    }
  }
}
