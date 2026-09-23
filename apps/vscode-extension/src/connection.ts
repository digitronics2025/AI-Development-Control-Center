import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage } from '@acc/shared';

export interface Discovery {
  url: string;
  token: string;
  dataDir: string;
}

/** Same default as the orchestrator's `defaultDataDir()`. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'AIDevControlCenter');
  return path.join(env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'ai-control-center');
}

/**
 * Find the running orchestrator: `runtime.json` (written on start, removed
 * on clean shutdown) gives the URL; `auth-token` gives the credential. Both
 * live in the user's private data folder.
 */
export function discover(dataDir: string): Discovery | null {
  const runtimeFile = path.join(dataDir, 'runtime.json');
  const tokenFile = path.join(dataDir, 'auth-token');
  if (!existsSync(runtimeFile) || !existsSync(tokenFile)) return null;
  try {
    const runtime = JSON.parse(readFileSync(runtimeFile, 'utf8')) as { url?: string };
    const token = readFileSync(tokenFile, 'utf8').trim();
    const url = runtime.url ?? '';
    // Only ever talk to a loopback orchestrator.
    if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(url) || !token) return null;
    return { url, token, dataDir };
  } catch {
    return null;
  }
}

export class ApiClient {
  constructor(private readonly d: Discovery) {}

  get baseUrl(): string {
    return this.d.url;
  }

  async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.d.url}${route}`, {
      method,
      headers: { authorization: `Bearer ${this.d.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
    return data as T;
  }

  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.d.url}/healthz`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/** Reconnecting WebSocket for status updates in the extension host. */
export class EventStream {
  private socket: WebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private stopped = false;

  constructor(
    private readonly d: Discovery,
    private readonly onMessage: (message: ServerMessage) => void,
    private readonly onState: (connected: boolean) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.terminate();
    this.socket = null;
  }

  private connect(): void {
    const wsUrl = `${this.d.url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(this.d.token)}`;
    const socket = new WebSocket(wsUrl, { headers: { host: new URL(this.d.url).host } });
    this.socket = socket;
    socket.on('open', () => {
      this.attempts = 0;
      this.onState(true);
    });
    socket.on('message', (raw) => {
      try {
        this.onMessage(JSON.parse(String(raw)) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    });
    const retry = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.onState(false);
      if (this.stopped) return;
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(this.attempts++, 4));
      this.timer = setTimeout(() => this.connect(), delay);
    };
    socket.on('close', retry);
    socket.on('error', () => socket.terminate());
  }
}
