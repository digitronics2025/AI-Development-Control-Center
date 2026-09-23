import { WebSocket } from 'ws';
import { REMOTE_LIMITS } from '@acc/shared';

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'waiting' | 'stopped';

export interface ConnectionHooks {
  /** A fresh session token for each attempt (challenge-response happens here). */
  session: () => Promise<string>;
  onOpen: () => void;
  onText: (text: string) => void;
  onClose: (info: { code: number; reason: string }) => void;
  /** An attempt failed before the socket opened; returning false stops retrying (e.g. the node was revoked). */
  onError: (error: Error) => boolean;
}

export const BACKOFF = { initialMs: 1_000, maxMs: 60_000, stableMs: 30_000 } as const;

/** Next delay: exponential from 1 s, capped at 60 s, with ±20 % jitter so a fleet does not reconnect in step. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF.maxMs, BACKOFF.initialMs * 2 ** Math.min(attempt, 10));
  return Math.round(base * (0.8 + random() * 0.4));
}

/**
 * The node's single outbound WebSocket to the relay. Nothing listens on this
 * machine for the cloud: the node dials out, authenticates with a
 * short-lived session, and redials with bounded backoff after any drop.
 */
export class RemoteConnection {
  private socket: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private openedAt = 0;
  private state: ConnectionState = 'idle';
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: string,
    private readonly hooks: ConnectionHooks,
  ) {}

  getState(): ConnectionState {
    return this.state;
  }

  start(): void {
    if (this.state !== 'idle' && this.state !== 'stopped') return;
    this.state = 'waiting';
    void this.connect();
  }

  stop(): void {
    this.state = 'stopped';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.clearPing();
    const socket = this.socket;
    this.socket = null;
    socket?.removeAllListeners();
    socket?.on('error', () => undefined);
    try {
      socket?.close(1000, 'node stopping');
    } catch {
      socket?.terminate();
    }
  }

  /** Redial now (e.g. after the user re-enabled remote access). */
  reconnectNow(): void {
    if (this.state === 'stopped' || this.state === 'open' || this.state === 'connecting') return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.connect();
  }

  send(text: string): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    if (text.length > REMOTE_LIMITS.frameBytes) return false;
    this.socket.send(text);
    return true;
  }

  isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  bufferedAmount(): number {
    return this.socket?.bufferedAmount ?? 0;
  }

  /** Re-read state after an await (stop() may have run meanwhile). */
  private stopped(): boolean {
    return this.state === 'stopped';
  }

  private async connect(): Promise<void> {
    if (this.stopped()) return;
    this.state = 'connecting';
    let session: string;
    try {
      session = await this.hooks.session();
    } catch (error) {
      if (this.stopped()) return;
      if (this.hooks.onError(error as Error)) this.schedule();
      else this.state = 'stopped';
      return;
    }
    if (this.stopped()) return;
    const socket = new WebSocket(this.url, {
      headers: { authorization: `Bearer ${session}` },
      handshakeTimeout: 15_000,
      maxPayload: REMOTE_LIMITS.frameBytes * 2,
      followRedirects: false,
    });
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.state = 'open';
      this.openedAt = Date.now();
      // Keep NAT and proxies from idling the connection out; the relay answers pings automatically.
      this.pingTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, 30_000);
      this.hooks.onOpen();
    });
    socket.on('message', (data, isBinary) => {
      if (this.socket !== socket || isBinary) return;
      this.hooks.onText(data.toString());
    });
    socket.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      socket.removeAllListeners('close');
      socket.on('error', () => undefined);
      socket.terminate();
      if (this.socket !== socket) return;
      this.socket = null;
      const retry = this.hooks.onError(Object.assign(new Error(`Relay refused the connection (${status})`), { status }));
      if (retry && this.state !== 'stopped') this.schedule();
      else this.state = 'stopped';
    });
    socket.on('error', (error) => {
      if (this.socket !== socket) return;
      if (socket.readyState !== WebSocket.OPEN && !this.hooks.onError(error)) this.state = 'stopped';
    });
    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearPing();
      const wasOpen = this.state === 'open';
      if (wasOpen && Date.now() - this.openedAt >= BACKOFF.stableMs) this.attempt = 0;
      if (wasOpen) this.hooks.onClose({ code, reason: reason.toString() });
      if (this.state !== 'stopped') this.schedule();
    });
  }

  private schedule(): void {
    if (this.state === 'stopped') return;
    this.state = 'waiting';
    const delay = backoffDelay(this.attempt++);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
    this.timer.unref?.();
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
