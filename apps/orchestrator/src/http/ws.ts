import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@acc/shared';
import type { AppServices } from '../app.js';

/** Drop log batches and terminal output for a client whose socket is this far behind; both refetch by cursor. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** A client this far behind is not reading at all: close it, and it resynchronises on reconnect (audit F-30). */
const STALLED_BYTES = 32 * 1024 * 1024;

/**
 * Realtime hub (PLAN §24). Every state message goes to every client; log
 * lines only go to clients that subscribed to that execution, so an idle
 * VS Code status bar never receives a build log.
 */
export function registerWebSocket(app: FastifyInstance, s: AppServices): void {
  app.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
    request.log.info({ origin: request.headers.origin ?? 'none' }, 'realtime client connected');
    const logSubscriptions = new Set<string>();
    const terminalSubscriptions = new Set<string>();
    const send = (message: ServerMessage) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > STALLED_BYTES) {
        request.log.warn({ buffered: socket.bufferedAmount }, 'realtime client stopped reading; closing it');
        socket.terminate();
        return;
      }
      if (message.type === 'logs') {
        if (!logSubscriptions.has(message.executionId)) return;
        if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
      }
      // Terminal output reaches only the clients showing that terminal.
      if (message.type === 'terminal.output') {
        if (!terminalSubscriptions.has(message.terminalId)) return;
        // The PTY keeps a cursor-addressed history: a viewer that falls behind fills the gap from it.
        if (!message.notice && socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
      }
      socket.send(JSON.stringify(message));
    };
    const unsubscribe = s.bus.subscribe(send);
    send({ type: 'hello', version: s.config.version, serverTime: new Date().toISOString(), startedAt: s.startedAt });

    socket.on('message', (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (message.type === 'subscribeLogs' && typeof message.executionId === 'string' && logSubscriptions.size < 50) {
        logSubscriptions.add(message.executionId);
      } else if (message.type === 'unsubscribeLogs' && typeof message.executionId === 'string') {
        logSubscriptions.delete(message.executionId);
      } else if (message.type === 'subscribeTerminal' && typeof message.terminalId === 'string' && terminalSubscriptions.size < 20) {
        terminalSubscriptions.add(message.terminalId);
      } else if (message.type === 'unsubscribeTerminal' && typeof message.terminalId === 'string') {
        terminalSubscriptions.delete(message.terminalId);
      } else if (message.type === 'terminal.input' && typeof message.terminalId === 'string' && typeof message.data === 'string' && message.data.length <= 64 * 1024) {
        // Operator keystrokes: only into a terminal this client is showing.
        if (terminalSubscriptions.has(message.terminalId)) {
          try {
            s.terminals.write(message.terminalId, message.data);
          } catch {
            /* closed terminal: the client learns from its status message */
          }
        }
      } else if (message.type === 'terminal.resize' && typeof message.terminalId === 'string' && terminalSubscriptions.has(message.terminalId)) {
        try {
          s.terminals.resize(message.terminalId, Number(message.cols), Number(message.rows));
        } catch {
          /* closed terminal */
        }
      } else if (message.type === 'ping' && socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: 'pong' }));
      }
    });

    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 25_000);
    socket.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    socket.on('error', () => socket.terminate());
  });
}
