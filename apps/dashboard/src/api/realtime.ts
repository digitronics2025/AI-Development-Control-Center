import type { ClientMessage, ServerMessage } from '@acc/shared';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface ConnectionState {
  status: ConnectionStatus;
  /** True once the socket has opened at least once in this session. */
  everConnected: boolean;
  attempts: number;
  lastChangeAt: number;
}

type Listener = () => void;

/**
 * WebSocket client with bounded exponential backoff. Every (re)connect
 * triggers `onOpen`, which the app uses to refetch and reconcile with the
 * orchestrator — the client never trusts its cache across a disconnect.
 */
export class RealtimeClient {
  private socket: WebSocket | null = null;
  private state: ConnectionState = { status: 'connecting', everConnected: false, attempts: 0, lastChangeAt: Date.now() };
  private readonly listeners = new Set<Listener>();
  private readonly logRefs = new Map<string, number>();
  private retryTimer: number | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly onMessage: (message: ServerMessage) => void,
    private readonly onOpen: (isReconnect: boolean) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
    window.addEventListener('online', this.reconnectNow);
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.reconnectNow);
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null;
    // Closing a socket that is still connecting logs a browser warning; close it once open instead.
    if (socket?.readyState === WebSocket.CONNECTING) socket.onopen = () => socket.close();
    else socket?.close();
  }

  getState = (): ConnectionState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  reconnectNow = (): void => {
    if (this.stopped || this.state.status === 'open') return;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.close();
    this.connect();
  };

  /** Ref-counted log subscription; survives reconnects. */
  subscribeLogs(executionId: string): () => void {
    const count = this.logRefs.get(executionId) ?? 0;
    this.logRefs.set(executionId, count + 1);
    if (count === 0) this.send({ type: 'subscribeLogs', executionId });
    return () => {
      const current = (this.logRefs.get(executionId) ?? 1) - 1;
      if (current <= 0) {
        this.logRefs.delete(executionId);
        this.send({ type: 'unsubscribeLogs', executionId });
      } else this.logRefs.set(executionId, current);
    };
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private setState(patch: Partial<ConnectionState>): void {
    this.state = { ...this.state, ...patch, lastChangeAt: Date.now() };
    for (const listener of this.listeners) listener();
  }

  private connect(): void {
    this.setState({ status: 'connecting' });
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      const isReconnect = this.state.everConnected;
      this.setState({ status: 'open', everConnected: true, attempts: 0 });
      for (const executionId of this.logRefs.keys()) this.send({ type: 'subscribeLogs', executionId });
      this.onOpen(isReconnect);
    };
    socket.onmessage = (event) => {
      try {
        this.onMessage(JSON.parse(String(event.data)) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.stopped) this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    const attempts = this.state.attempts + 1;
    this.setState({ status: 'closed', attempts });
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempts - 1, 4)) + Math.random() * 400;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}
