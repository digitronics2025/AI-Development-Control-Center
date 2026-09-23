import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { redact } from '@acc/security';

/**
 * MCP gateway (V2 plan §29): the Control Center as a client of other MCP
 * servers (Playwright, GitHub, databases, internal tools). Connections are
 * lazy, pooled, closed when idle, and every call has a timeout. Which tools
 * a task may use is decided by the orchestrator's policy, not here.
 */

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string | null;
  args?: string[];
  url?: string | null;
  /** Resolved environment (credential values already injected by the broker). */
  env?: Record<string, string>;
  /** Resolved HTTP headers for `http` servers. */
  headers?: Record<string, string>;
  cwd?: string | null;
  timeoutMs?: number;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean | null;
  destructiveHint: boolean | null;
}

export interface McpHealth {
  ok: boolean;
  serverName: string | null;
  serverVersion: string | null;
  tools: McpToolInfo[];
  error: string | null;
  checkedAt: string;
  durationMs: number;
}

export interface McpCallResult {
  ok: boolean;
  text: string;
  structured: unknown;
  isError: boolean;
}

interface Pooled {
  client: Client;
  lastUsed: number;
  close: () => Promise<void>;
}

const IDLE_MS = 5 * 60_000;

function fingerprint(config: McpServerConfig): string {
  return JSON.stringify([config.transport, config.command, config.args, config.url, Object.keys(config.env ?? {}).sort(), Object.keys(config.headers ?? {}).sort()]);
}

export class McpGateway {
  private readonly pool = new Map<string, Pooled & { key: string }>();
  private readonly connecting = new Map<string, Promise<Pooled & { key: string }>>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly clientInfo = { name: 'ai-development-control-center', version: '0.1.0' }) {
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  private async open(config: McpServerConfig): Promise<Pooled & { key: string }> {
    const client = new Client(this.clientInfo, { capabilities: {} });
    const timeout = config.timeoutMs ?? 30_000;
    if (config.transport === 'stdio') {
      if (!config.command) throw new Error('A stdio MCP server needs a command');
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
        cwd: config.cwd ?? undefined,
        stderr: 'pipe',
      });
      await client.connect(transport, { timeout });
      return { client, lastUsed: Date.now(), key: fingerprint(config), close: () => client.close() };
    }
    if (!config.url) throw new Error('An HTTP MCP server needs a URL');
    const transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers ?? {} } });
    await client.connect(transport, { timeout });
    return { client, lastUsed: Date.now(), key: fingerprint(config), close: () => client.close() };
  }

  private async connection(config: McpServerConfig): Promise<Pooled> {
    const key = fingerprint(config);
    const existing = this.pool.get(config.id);
    if (existing && existing.key === key) {
      existing.lastUsed = Date.now();
      return existing;
    }
    if (existing) await this.disconnect(config.id);
    const pending = this.connecting.get(config.id);
    if (pending) return pending;
    const job = this.open(config)
      .then((c) => {
        this.pool.set(config.id, c);
        c.client.onclose = () => {
          if (this.pool.get(config.id) === c) this.pool.delete(config.id);
        };
        return c;
      })
      .finally(() => this.connecting.delete(config.id));
    this.connecting.set(config.id, job);
    return job;
  }

  async listTools(config: McpServerConfig): Promise<McpToolInfo[]> {
    const c = await this.connection(config);
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.client.listTools(cursor ? { cursor } : {}, { timeout: config.timeoutMs ?? 30_000 });
      for (const t of page.tools) {
        tools.push({
          name: t.name,
          description: (t.description ?? '').slice(0, 2000),
          inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
          readOnlyHint: t.annotations?.readOnlyHint ?? null,
          destructiveHint: t.annotations?.destructiveHint ?? null,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < 1000);
    return tools;
  }

  /** Connect, list tools, report. A failed check closes the connection. */
  async check(config: McpServerConfig): Promise<McpHealth> {
    const started = Date.now();
    try {
      const tools = await this.listTools(config);
      const pooled = this.pool.get(config.id);
      const info = pooled?.client.getServerVersion();
      return { ok: true, serverName: info?.name ?? null, serverVersion: info?.version ?? null, tools, error: null, checkedAt: new Date().toISOString(), durationMs: Date.now() - started };
    } catch (error) {
      await this.disconnect(config.id);
      return { ok: false, serverName: null, serverVersion: null, tools: [], error: redact((error as Error).message).slice(0, 500), checkedAt: new Date().toISOString(), durationMs: Date.now() - started };
    }
  }

  async callTool(config: McpServerConfig, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const c = await this.connection(config);
    const result = await c.client.callTool({ name, arguments: args }, undefined, { timeout: config.timeoutMs ?? 120_000, signal });
    c.lastUsed = Date.now();
    const content = (result.content as Array<{ type: string; text?: string }> | undefined) ?? [];
    const text = redact(content.map((part) => (part.type === 'text' ? (part.text ?? '') : `[${part.type}]`)).join('\n'));
    return { ok: !result.isError, text, structured: result.structuredContent ?? null, isError: Boolean(result.isError) };
  }

  async disconnect(id: string): Promise<void> {
    const c = this.pool.get(id);
    this.pool.delete(id);
    await c?.close().catch(() => undefined);
  }

  private async sweep(): Promise<void> {
    for (const [id, c] of this.pool) if (Date.now() - c.lastUsed > IDLE_MS) await this.disconnect(id);
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.pool.keys()].map((id) => this.disconnect(id)));
  }
}
