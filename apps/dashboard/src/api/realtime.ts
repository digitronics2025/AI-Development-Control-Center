import type { ClientMessage, RelayedServerMessage, ServerMessage } from '@acc/shared';

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface ConnectionState {
  status: ConnectionStatus;
  /** True once the socket has opened at least once in this session. */
  everConnected: boolean;
  attempts: number;
  lastChangeAt: number;
}

type Listener = () => void;

/** How often a visible page checks that its socket still carries traffic. */
export const HEARTBEAT_MS = 25_000;
/** A ping without any answer for this long means the socket is dead even though it never closed. */
export const PONG_DEADLINE_MS = 10_000;
/**
 * Sent verbatim, never decorated with a node id: the cloud hub answers exactly this
 * string itself (setWebSocketAutoResponse) and the orchestrator replies `{"type":"pong"}`.
 */
const PING_FRAME = '{"type":"ping"}';

/**
 * Cloud mode only: which relayed messages this page keeps (those of the selected
 * node, plus the cloud's own), and what the hub needs added to outgoing ones.
 */
export interface RealtimeRouting {
  accept: (message: RelayedServerMessage) => boolean;
  decorate: (message: ClientMessage) => ClientMessage & { nodeId?: string };
  onCloudMessage: (message: RelayedServerMessage) => void;
  /** Called after each failed (re)connect, so the page can tell an expired sign-in from a network fault. */
  onLinkFailure?: (attempts: number) => void;
}

/**
 * WebSocket client with bounded exponential backoff. Every (re)connect
 * triggers `onOpen`, which the app uses to refetch and reconcile with the
 * orchestrator — the client never trusts its cache across a disconnect.
 *
 * A socket can die without closing (a phone that slept, a switch from Wi-Fi to
 * mobile data): while the page is visible it is pinged every HEARTBEAT_MS, and
 * whenever the page comes back (visible again, restored from the back/forward
 * cache, back online) it is probed at once. No answer within PONG_DEADLINE_MS
 * replaces the socket, which runs the normal reconnect and refetch.
 */
export class RealtimeClient {
  private socket: WebSocket | null = null;
  private state: ConnectionState = { status: 'connecting', everConnected: false, attempts: 0, lastChangeAt: Date.now() };
  private readonly listeners = new Set<Listener>();
  private readonly logRefs = new Map<string, number>();
  /** Terminal output is delivered to listeners directly, never through the query cache. */
  private readonly terminalListeners = new Map<string, Set<(data: string, cursor: number, notice?: boolean) => void>>();
  private retryTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private pongTimer: number | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly onMessage: (message: ServerMessage) => void,
    private readonly onOpen: (isReconnect: boolean) => void,
    private readonly routing: RealtimeRouting | null = null,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
    window.addEventListener('online', this.probe);
    window.addEventListener('pageshow', this.probe);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.probe);
    window.removeEventListener('pageshow', this.probe);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.stopHeartbeat();
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

  /** Check the link now: reconnect if it is down, ping it if it claims to be up. */
  probe = (): void => {
    if (this.stopped) return;
    if (this.state.status === 'open') this.ping();
    else this.reconnectNow();
  };

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible') this.probe();
  };

  private ping(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.pongTimer !== null) return;
    try {
      socket.send(PING_FRAME);
    } catch {
      this.replaceSocket();
      return;
    }
    this.pongTimer = window.setTimeout(() => {
      this.pongTimer = null;
      if (this.socket === socket) this.replaceSocket();
    }, PONG_DEADLINE_MS);
  }

  /** Any frame proves the socket is alive. */
  private markAlive(): void {
    if (this.pongTimer !== null) window.clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.markAlive();
  }

  /** Drop a socket that stopped answering without waiting for a close that may never come, and connect again. */
  private replaceSocket(): void {
    if (this.stopped) return;
    const dead = this.socket;
    this.socket = null;
    this.stopHeartbeat();
    if (dead) {
      dead.onopen = dead.onmessage = dead.onclose = dead.onerror = null;
      try {
        dead.close();
      } catch {
        /* already closing */
      }
    }
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  }

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

  /** Receive a terminal's output while mounted; the subscription is renewed after reconnects. */
  subscribeTerminal(terminalId: string, listener: (data: string, cursor: number, notice?: boolean) => void): () => void {
    const set = this.terminalListeners.get(terminalId) ?? new Set();
    set.add(listener);
    this.terminalListeners.set(terminalId, set);
    if (set.size === 1) this.send({ type: 'subscribeTerminal', terminalId });
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.terminalListeners.delete(terminalId);
        this.send({ type: 'unsubscribeTerminal', terminalId });
      }
    };
  }

  sendTerminalInput(terminalId: string, data: string): void {
    this.send({ type: 'terminal.input', terminalId, data });
  }

  resizeTerminal(terminalId: string, cols: number, rows: number): void {
    this.send({ type: 'terminal.resize', terminalId, cols, rows });
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(this.routing ? this.routing.decorate(message) : message));
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
      this.stopHeartbeat();
      this.heartbeatTimer = window.setInterval(() => {
        if (document.visibilityState === 'visible') this.ping();
      }, HEARTBEAT_MS);
      for (const executionId of this.logRefs.keys()) this.send({ type: 'subscribeLogs', executionId });
      for (const terminalId of this.terminalListeners.keys()) this.send({ type: 'subscribeTerminal', terminalId });
      this.onOpen(isReconnect);
    };
    socket.onmessage = (event) => {
      this.markAlive();
      try {
        const relayed = JSON.parse(String(event.data)) as RelayedServerMessage | { type: 'pong' };
        if (relayed.type === 'pong') return;
        if (this.routing) {
          if (relayed.type === 'remote.node' || relayed.type === 'remote.command') {
            // Only the cloud itself sends these; one relayed from a node (it carries a nodeId) is an impersonation attempt.
            if (!relayed.nodeId) this.routing.onCloudMessage(relayed);
            return;
          }
          if (!this.routing.accept(relayed)) return;
        }
        const message = relayed as ServerMessage;
        if (message.type === 'terminal.output') {
          for (const listener of this.terminalListeners.get(message.terminalId) ?? []) listener(message.data, message.cursor, message.notice);
          return;
        }
        this.onMessage(message);
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      if (!this.stopped) this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    const attempts = this.state.attempts + 1;
    this.setState({ status: 'closed', attempts });
    this.routing?.onLinkFailure?.(attempts);
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempts - 1, 4)) + Math.random() * 400;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}
