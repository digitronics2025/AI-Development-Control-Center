import { McpGateway, type McpServerConfig } from '@acc/mcp';
import { mcpServerInputSchema, type McpServerInput, type McpServerView, type PermissionLevel } from '@acc/shared';
import { failure, missing, type ToolOperation, type ToolProvider } from '@acc/tools';
import { z } from 'zod';
import type { Bus } from '../bus.js';
import { newId, now } from '../store/store.js';
import type { CredentialBroker } from './credentials.js';
import type { ToolService } from './service.js';
import type { McpServerRecord, ToolStore } from './store.js';

export class McpError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'DUPLICATE' | 'INVALID',
  ) {
    super(message);
  }
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'server';
}

/**
 * MCP server registry (V2 plan §29). Each enabled, healthy server becomes a
 * provider `mcp:<id>` whose tools are capabilities `mcp.<server>.<tool>`,
 * so calls to it pass the same router, policy, audit and redaction as any
 * other tool. Servers get their secrets from the broker, never from config
 * stored in plain text; they are opt-in per task profile (operator sessions
 * see them, agent profiles only when listed).
 */
export class McpService {
  readonly gateway = new McpGateway();

  constructor(
    private readonly store: ToolStore,
    private readonly bus: Bus,
    private readonly tools: ToolService,
    private readonly credentials: CredentialBroker,
  ) {}

  list(): McpServerView[] {
    return this.store.listMcpServers();
  }

  get(id: string): McpServerView {
    const s = this.store.mcpServer(id);
    if (!s) throw new McpError('MCP server not found', 'NOT_FOUND');
    return s;
  }

  private async config(s: McpServerRecord, repositoryId: string | null = null): Promise<McpServerConfig> {
    const env = await this.credentials.envForMapping(s.envCredentials, repositoryId);
    return {
      id: s.id,
      name: s.name,
      transport: s.transport,
      command: s.command,
      args: s.args,
      url: s.url,
      env: s.transport === 'stdio' ? env : undefined,
      headers: s.transport === 'http' ? env : undefined,
      timeoutMs: s.timeoutMs,
    };
  }

  private publish(id: string): McpServerView {
    const view = this.get(id);
    this.bus.publish({ type: 'mcpServer', server: view });
    return view;
  }

  async create(raw: McpServerInput): Promise<McpServerView> {
    const input = mcpServerInputSchema.parse(raw);
    if (this.store.listMcpServers().some((s) => s.name.toLowerCase() === input.name.toLowerCase())) throw new McpError(`An MCP server named "${input.name}" exists`, 'DUPLICATE');
    const ts = now();
    const rec: McpServerRecord = { id: newId(), name: input.name, transport: input.transport, command: input.command ?? null, args: input.args, url: input.url ?? null, envCredentials: input.envCredentials, enabled: input.enabled, permissionLevel: input.permissionLevel as PermissionLevel, allowedTools: input.allowedTools, timeoutMs: input.timeoutMs, health: null, createdAt: ts, updatedAt: ts };
    this.store.upsertMcpServer(rec);
    if (rec.enabled) await this.check(rec.id);
    return this.publish(rec.id);
  }

  async update(id: string, raw: Partial<McpServerInput>): Promise<McpServerView> {
    const current = this.get(id);
    const input = mcpServerInputSchema.parse({ ...current, ...raw });
    const rec: McpServerRecord = { ...current, ...input, command: input.command ?? null, url: input.url ?? null, permissionLevel: input.permissionLevel as PermissionLevel, updatedAt: now() };
    this.store.upsertMcpServer(rec);
    await this.gateway.disconnect(id);
    if (rec.enabled) await this.check(id);
    else this.tools.unregisterProvider(`mcp:${id}`);
    return this.publish(id);
  }

  async remove(id: string): Promise<void> {
    this.get(id);
    await this.gateway.disconnect(id);
    this.tools.unregisterProvider(`mcp:${id}`);
    this.store.deleteMcpServer(id);
    this.bus.publish({ type: 'mcpServer.deleted', serverId: id });
  }

  /** Connect, discover tools, store health and (re)register the provider. */
  async check(id: string): Promise<McpServerView> {
    const s = this.store.mcpServer(id);
    if (!s) throw new McpError('MCP server not found', 'NOT_FOUND');
    const health = await this.gateway.check(await this.config(s));
    const tools = health.tools.filter((t) => !s.allowedTools || s.allowedTools.includes(t.name));
    this.store.upsertMcpServer({ ...s, health: { ok: health.ok, serverName: health.serverName, serverVersion: health.serverVersion, error: health.error, checkedAt: health.checkedAt, tools: tools.map((t) => ({ name: t.name, description: t.description, readOnlyHint: t.readOnlyHint, destructiveHint: t.destructiveHint })) }, updatedAt: now() });
    if (health.ok && s.enabled) this.tools.registerProvider(this.provider({ ...s, health: this.get(id).health }), 'mcp');
    else this.tools.unregisterProvider(`mcp:${id}`);
    return this.publish(id);
  }

  /** Register every enabled server that was healthy last time (no connections are opened until used). */
  restore(): void {
    for (const s of this.store.listMcpServers()) if (s.enabled && s.health?.ok) this.tools.registerProvider(this.provider(s), 'mcp');
  }

  private provider(s: McpServerRecord): ToolProvider {
    const prefix = `mcp.${slug(s.name)}`;
    const operations: ToolOperation[] = (s.health?.tools ?? []).map((t) => {
      const destructive = t.destructiveHint === true;
      return {
        id: `${prefix}.${t.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 60)}`,
        title: `${s.name}: ${t.name}`,
        description: t.description || `Tool ${t.name} of MCP server ${s.name}`,
        input: z.record(z.string(), z.unknown()),
        level: (destructive ? Math.max(3, s.permissionLevel) : s.permissionLevel) as PermissionLevel,
        classify: () => ({ reasons: [`MCP server ${s.name}${destructive ? ' (the server marks this tool destructive)' : ''}`], risk: destructive ? 'elevated' : 'normal', effects: ['network'] }),
        run: async (input, ctx) => {
          const current = this.store.mcpServer(s.id);
          if (!current?.enabled) return failure('UNAVAILABLE', `MCP server ${s.name} is disabled`);
          try {
            const r = await this.gateway.callTool(await this.config(current), t.name, input as Record<string, unknown>, ctx.signal);
            return { ok: r.ok, summary: `${s.name}.${t.name}: ${r.ok ? 'ok' : 'error'}`, stdout: r.text.slice(0, 64_000), output: r.structured ?? undefined, ...(r.ok ? {} : { error: { code: 'FAILED' as const, message: r.text.slice(0, 500) } }) };
          } catch (error) {
            return failure('FAILED', `${s.name}.${t.name} failed: ${(error as Error).message}`);
          }
        },
      };
    });
    return {
      id: `mcp:${s.id}`,
      name: `MCP · ${s.name}`,
      description: `Tools from the MCP server "${s.name}" (${s.transport}).`,
      category: 'mcp',
      builtin: true,
      async detect() {
        return s.health?.ok ? { installed: true, version: s.health.serverVersion, path: s.command ?? s.url, auth: { required: false, state: 'not_required', message: null }, message: s.health.serverName } : missing(s.health?.error ?? 'Not checked yet');
      },
      operations,
    };
  }

  close(): Promise<void> {
    return this.gateway.close();
  }
}
