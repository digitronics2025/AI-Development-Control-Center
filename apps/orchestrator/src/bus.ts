import { EventEmitter } from 'node:events';
import type { ServerMessage } from '@acc/shared';

/**
 * In-process fan-out of state changes. Services publish complete entities;
 * the WebSocket hub forwards them to every connected client (dashboard and
 * VS Code alike), which is what keeps both views on one source of truth.
 */
export class Bus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(message: ServerMessage): void {
    this.emitter.emit('message', message);
  }

  subscribe(listener: (message: ServerMessage) => void): () => void {
    this.emitter.on('message', listener);
    return () => this.emitter.off('message', listener);
  }
}
