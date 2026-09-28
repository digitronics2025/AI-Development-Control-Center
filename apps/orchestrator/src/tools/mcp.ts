import { randomBytes } from 'node:crypto';
import { finishMcpSignIn, McpGateway, McpOAuthProvider, McpSignInRequired, startMcpSignIn, type McpOAuthState, type McpOAuthStore, type McpServerConfig } from '@acc/mcp';
import { redact, registerSecretValues } from '@acc/security';
import { DEFAULT_PORT, mcpServerInputSchema, type McpServerInput, type McpServerView, type PermissionLevel } from '@acc/shared';
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

/** A tool's input schema as stored and published: 16 KB of JSON at most, else none (the call still validates). */
function keptSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!schema || typeof schema !== 'object') return null;
  const json = JSON.stringify(schema);
  return json.length <= 16 * 1024 ? (JSON.parse(json) as Record<string, unknown>) : null;
}

/** Where an authorization server sends the browser back; loopback only, so it reaches this machine's orchestrator. */
export const MCP_OAUTH_CALLBACK = '/oauth/mcp/callback';
const SIGN_IN_TTL_MS = 10 * 60_000;
const MAX_PENDING_SIGN_INS = 20;

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
  /** Sign-ins the operator started: single-use state → server, for ten minutes. In memory: a restart asks again. */
  private readonly pending = new Map<string, { serverId: string; redirectUrl: string; expiresAt: number }>();

  constructor(
    private readonly store: ToolStore,
    private readonly bus: Bus,
    private readonly tools: ToolService,
    private readonly credentials: CredentialBroker,
    /** The port this orchestrator is reached on, for the callback address of background calls. */
    private port: number = DEFAULT_PORT,
  ) {}

  /** The port the HTTP server actually listens on (known only after listen). */
  setListenPort(port: number): void {
    this.port = port;
  }

  private view(s: McpServerRecord): McpServerView {
    if (s.auth !== 'oauth') return { ...s, oauth: null };
    const o = this.store.mcpOAuth(s.id);
    return { ...s, oauth: { signedIn: Boolean(o?.signedInAt), signedInAt: o?.signedInAt ?? null, expiresAt: o?.expiresAt ?? null } };
  }

  list(): McpServerView[] {
    return this.store.listMcpServers().map((s) => this.view(s));
  }

  get(id: string): McpServerView {
    const s = this.store.mcpServer(id);
    if (!s) throw new McpError('MCP server not found', 'NOT_FOUND');
    return this.view(s);
  }

  static redirectUrl(port: number): string {
    return `http://127.0.0.1:${port}${MCP_OAUTH_CALLBACK}`;
  }

  /** One server's sign-in, sealed with the broker's key and bound to the server, so it opens as nothing else. */
  private oauthStore(serverId: string): McpOAuthStore {
    const binding = `mcp-oauth:${serverId}`;
    return {
      load: async () => {
        const row = this.store.mcpOAuth(serverId);
        if (!row) return null;
        const state = JSON.parse(await this.credentials.openValue(row, binding)) as McpOAuthState;
        if (state.tokens) registerSecretValues([state.tokens.access_token, ...(state.tokens.refresh_token ? [state.tokens.refresh_token] : [])]);
        return state;
      },
      save: async (state: McpOAuthState) => {
        // Never shown or logged: the redactor masks the tokens wherever they might surface.
        if (state.tokens) registerSecretValues([state.tokens.access_token, ...(state.tokens.refresh_token ? [state.tokens.refresh_token] : [])]);
        const sealed = await this.credentials.sealValue(JSON.stringify(state), binding);
        const savedAt = state.tokens ? (state.savedAt ?? now()) : null;
        const expiresIn = state.tokens?.expires_in;
        const expiresAt = savedAt && typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? new Date(Date.parse(savedAt) + expiresIn * 1000).toISOString() : null;
        this.store.upsertMcpOAuth({ serverId, ...sealed, signedInAt: savedAt, expiresAt, updatedAt: now() });
      },
    };
  }

  private oauthProvider(s: McpServerRecord, options: { interactive: boolean; redirectUrl?: string; state?: string }): McpOAuthProvider {
    return new McpOAuthProvider(this.oauthStore(s.id), { redirectUrl: options.redirectUrl ?? McpService.redirectUrl(this.port), interactive: options.interactive, state: options.state, scope: s.oauthScope ?? undefined });
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
      ...(s.transport === 'http' && s.auth === 'oauth' ? { oauth: this.oauthProvider(s, { interactive: false }) } : {}),
    };
  }

  /**
   * Start signing in to an OAuth server: the address the operator opens, or `authorized` when the saved
   * sign-in still works. `port` is the one the operator reached this orchestrator on (null: the one it listens on).
   */
  async startSignIn(id: string, port: number | null): Promise<{ authorized: true; server: McpServerView } | { authorized: false; authorizationUrl: string }> {
    const s = this.store.mcpServer(id);
    if (!s) throw new McpError('MCP server not found', 'NOT_FOUND');
    if (s.auth !== 'oauth' || s.transport !== 'http' || !s.url) throw new McpError(`${s.name} does not sign in with OAuth`, 'INVALID');
    const redirectUrl = McpService.redirectUrl(port ?? this.port);
    const store = this.oauthStore(id);
    // A client registered for another callback address (another port) is registered again.
    const saved = await store.load();
    const registered = saved?.client && 'redirect_uris' in saved.client ? (saved.client.redirect_uris as string[]) : null;
    if (saved && registered && !registered.includes(redirectUrl)) await store.save({ ...saved, client: undefined });
    const state = randomBytes(24).toString('base64url');
    let result;
    try {
      result = await startMcpSignIn(s.url, this.oauthProvider(s, { interactive: true, redirectUrl, state }), s.oauthScope ?? undefined);
    } catch (error) {
      throw new McpError(`Could not start signing in to ${s.name}: ${redact((error as Error).message).slice(0, 300)}`, 'INVALID');
    }
    if (result.authorized) return { authorized: true, server: await this.check(id) };
    // One sign-in per server at a time: this one's code verifier replaced any earlier one, whose link could only fail
    // at the exchange, so it is forgotten and says to start again.
    for (const [key, p] of this.pending) if (p.expiresAt < Date.now() || p.serverId === id) this.pending.delete(key);
    while (this.pending.size >= MAX_PENDING_SIGN_INS) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(state, { serverId: id, redirectUrl, expiresAt: Date.now() + SIGN_IN_TTL_MS });
    return { authorized: false, authorizationUrl: result.authorizationUrl };
  }

  /** The callback: the state must be one this orchestrator issued, unused and unexpired; then the code becomes sealed tokens. */
  async finishSignIn(state: string, code: string): Promise<McpServerView> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt < Date.now()) throw new McpError('This sign-in link has expired or was already used; start signing in again from Tools → MCP servers', 'INVALID');
    const s = this.store.mcpServer(pending.serverId);
    if (!s || s.auth !== 'oauth' || !s.url) throw new McpError('That MCP server no longer signs in with OAuth', 'INVALID');
    try {
      await finishMcpSignIn(s.url, this.oauthProvider(s, { interactive: true, redirectUrl: pending.redirectUrl }), code, s.oauthScope ?? undefined);
    } catch (error) {
      throw new McpError(`Signing in to ${s.name} failed: ${redact((error as Error).message).slice(0, 300)}`, 'INVALID');
    }
    await this.gateway.disconnect(s.id);
    return this.check(s.id);
  }

  /** A refused or cancelled sign-in at the authorization server: forget the state. */
  cancelSignIn(state: string): void {
    this.pending.delete(state);
  }

  /** Forget the sign-in (tokens and client registration); the server's tools stop until the operator signs in again. */
  async signOut(id: string): Promise<McpServerView> {
    this.get(id);
    this.store.deleteMcpOAuth(id);
    await this.gateway.disconnect(id);
    return this.check(id);
  }

  private publish(id: string): McpServerView {
    const view = this.get(id);
    this.bus.publish({ type: 'mcpServer', server: view });
    return view;
  }

  /** A media (generation) key opens only for the media tools, behind the spend gate: a server variable would get nothing. */
  private refuseMediaCredentials(envCredentials: Record<string, string>): void {
    const media = Object.entries(envCredentials).filter(([, name]) => this.credentials.kindOf(name) === 'media');
    if (media.length) throw new McpError(`${media.map(([v, name]) => `${v} (${name})`).join(', ')}: a media credential is read only by the media tools, behind the spend gate, so an MCP server cannot use it`, 'INVALID');
  }

  async create(raw: McpServerInput): Promise<McpServerView> {
    const input = mcpServerInputSchema.parse(raw);
    this.refuseMediaCredentials(input.envCredentials);
    if (this.store.listMcpServers().some((s) => s.name.toLowerCase() === input.name.toLowerCase())) throw new McpError(`An MCP server named "${input.name}" exists`, 'DUPLICATE');
    const ts = now();
    const rec: McpServerRecord = { id: newId(), name: input.name, transport: input.transport, command: input.command ?? null, args: input.args, url: input.url ?? null, envCredentials: input.envCredentials, enabled: input.enabled, permissionLevel: input.permissionLevel as PermissionLevel, allowedTools: input.allowedTools, timeoutMs: input.timeoutMs, auth: input.auth, oauthScope: input.oauthScope || null, health: null, createdAt: ts, updatedAt: ts };
    this.store.upsertMcpServer(rec);
    if (rec.enabled) await this.check(rec.id);
    return this.publish(rec.id);
  }

  async update(id: string, raw: Partial<McpServerInput>): Promise<McpServerView> {
    const { oauth: _status, ...current } = this.get(id);
    const input = mcpServerInputSchema.parse({ ...current, ...raw });
    if (raw.envCredentials) this.refuseMediaCredentials(input.envCredentials);
    const rec: McpServerRecord = { ...current, ...input, command: input.command ?? null, url: input.url ?? null, permissionLevel: input.permissionLevel as PermissionLevel, oauthScope: input.oauthScope || null, updatedAt: now() };
    this.store.upsertMcpServer(rec);
    // A sign-in belongs to one server address: another URL, or no OAuth any more, forgets it.
    if (current.auth === 'oauth' && (rec.auth !== 'oauth' || rec.url !== current.url)) this.store.deleteMcpOAuth(id);
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

  /** An OAuth server nobody signed in to: never contacted in the background (no client registration, no discovery). */
  private notSignedIn(s: McpServerRecord): boolean {
    return s.auth === 'oauth' && !this.store.mcpOAuth(s.id)?.signedInAt;
  }

  /** Connect, discover tools, store health and (re)register the provider. */
  async check(id: string): Promise<McpServerView> {
    const s = this.store.mcpServer(id);
    if (!s) throw new McpError('MCP server not found', 'NOT_FOUND');
    const health = this.notSignedIn(s)
      ? { ok: false, serverName: null, serverVersion: null, tools: [], error: new McpSignInRequired(s.name).message, checkedAt: now(), durationMs: 0 }
      : await this.gateway.check(await this.config(s));
    const tools = health.tools.filter((t) => !s.allowedTools || s.allowedTools.includes(t.name));
    this.store.upsertMcpServer({ ...s, health: { ok: health.ok, serverName: health.serverName, serverVersion: health.serverVersion, error: health.error, checkedAt: health.checkedAt, tools: tools.map((t) => ({ name: t.name, description: t.description, readOnlyHint: t.readOnlyHint, destructiveHint: t.destructiveHint, inputSchema: keptSchema(t.inputSchema) })) }, updatedAt: now() });
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
        ...(t.inputSchema ? { inputJsonSchema: t.inputSchema } : {}),
        // The server's own hint: never changes anything (and not also marked destructive).
        ...(t.readOnlyHint === true && !destructive ? { readOnly: true } : {}),
        level: (destructive ? Math.max(3, s.permissionLevel) : s.permissionLevel) as PermissionLevel,
        classify: () => ({ reasons: [`MCP server ${s.name}${destructive ? ' (the server marks this tool destructive)' : ''}`], risk: destructive ? 'elevated' : 'normal', effects: ['network'] }),
        // Its arguments are checked for secrets before callTool (SEC-4). An HTTP server is judged by its URL's host, as any
        // request there (a stored credential whose audience holds that host is exempt); a stdio server has no host, so none is.
        outbound: (input) => [{ ...(s.transport === 'http' && s.url ? { url: s.url } : { target: `the MCP server "${s.name}"` }), body: input }],
        run: async (input, ctx) => {
          const current = this.store.mcpServer(s.id);
          if (!current?.enabled) return failure('UNAVAILABLE', `MCP server ${s.name} is disabled`);
          if (this.notSignedIn(current)) return failure('AUTH_REQUIRED', `${new McpSignInRequired(s.name).message}. This is an operator decision.`);
          try {
            const r = await this.gateway.callTool(await this.config(current), t.name, input as Record<string, unknown>, ctx.signal);
            // Pictures the server returned are shown to the model and kept with the task.
            const images = r.images.map((img, i) => ({ name: `${slug(s.name)}-${t.name}-${i + 1}.${img.mime === 'image/png' ? 'png' : 'jpg'}`.slice(0, 120), mime: img.mime, data: img.data }));
            const artifacts = ctx.artifacts ? await Promise.all(images.map((img) => ctx.artifacts!.write({ name: img.name, type: 'image', content: img.data, mime: img.mime }))) : [];
            return {
              ok: r.ok,
              summary: `${s.name}.${t.name}: ${r.ok ? 'ok' : 'error'}${images.length ? ` · ${images.length} picture${images.length === 1 ? '' : 's'}` : ''}`,
              stdout: r.text.slice(0, 64_000),
              output: r.structured ?? undefined,
              ...(images.length ? { images, artifacts } : {}),
              ...(r.ok ? {} : { error: { code: 'FAILED' as const, message: r.text.slice(0, 500) } }),
            };
          } catch (error) {
            if (error instanceof McpSignInRequired) return failure('AUTH_REQUIRED', `${error.message}. This is an operator decision.`);
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
