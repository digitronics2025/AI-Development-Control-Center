// A stand-in remote MCP server that signs in with OAuth 2.1 (discovery, dynamic
// client registration, PKCE S256, code exchange, refresh), for gateway and
// orchestrator tests. Loopback only; tokens are random per run.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface OAuthMcpFixture {
  /** The MCP endpoint (`<base>/mcp`). */
  url: string;
  base: string;
  /** Every access and refresh token issued, so tests can prove none of them leaks. */
  issued: string[];
  /** Requests the MCP endpoint answered with 200 (signed in). */
  calls: number;
  /** Plays the operator approving in the browser: the address the authorization server redirects to. */
  approve(authorizationUrl: string): Promise<string>;
  /** Expire every access token (refresh still works). */
  expireAccess(): void;
  /** Expire every refresh token too (a new sign-in is needed). */
  expireAll(): void;
  close(): Promise<void>;
}

const token = (prefix: string) => `${prefix}_${randomBytes(18).toString('base64url')}`;
const b64url = (buf: Buffer) => buf.toString('base64url');

async function body(req: http.IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text;
}

function json(res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}

function mcpServer(): Server {
  const server = new Server({ name: 'oauth-fixture', version: '2.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'whoami', description: 'Say who is signed in', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'signed in as the operator' }] }));
  return server;
}

export async function startOAuthMcpServer(): Promise<OAuthMcpFixture> {
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string }>();
  const access = new Set<string>();
  const refresh = new Map<string, string>();
  const issued: string[] = [];
  let base = '';
  const state = { calls: 0 };

  const issue = (clientId: string) => {
    const a = token('at');
    const r = token('rt');
    access.add(a);
    refresh.set(r, clientId);
    issued.push(a, r);
    return { access_token: a, token_type: 'Bearer', expires_in: 3600, refresh_token: r };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    try {
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        });
      }
      if (url.pathname === '/register' && req.method === 'POST') {
        const meta = JSON.parse(await body(req)) as { redirect_uris: string[] };
        const clientId = token('client');
        clients.set(clientId, { redirectUris: meta.redirect_uris });
        return json(res, 201, { ...meta, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) });
      }
      if (url.pathname === '/authorize') {
        const q = url.searchParams;
        const client = clients.get(q.get('client_id') ?? '');
        const redirectUri = q.get('redirect_uri') ?? '';
        if (!client || !client.redirectUris.includes(redirectUri) || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return json(res, 400, { error: 'invalid_request' });
        const code = token('code');
        codes.set(code, { clientId: q.get('client_id')!, redirectUri, challenge: q.get('code_challenge')! });
        const back = new URL(redirectUri);
        back.searchParams.set('code', code);
        if (q.get('state')) back.searchParams.set('state', q.get('state')!);
        res.writeHead(302, { location: back.href });
        return res.end();
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await body(req));
        if (form.get('grant_type') === 'authorization_code') {
          const grant = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          if (!grant || grant.redirectUri !== form.get('redirect_uri') || grant.clientId !== form.get('client_id') || b64url(createHash('sha256').update(verifier).digest()) !== grant.challenge) {
            return json(res, 400, { error: 'invalid_grant' });
          }
          return json(res, 200, issue(grant.clientId));
        }
        if (form.get('grant_type') === 'refresh_token') {
          const clientId = refresh.get(form.get('refresh_token') ?? '');
          if (!clientId) return json(res, 400, { error: 'invalid_grant' });
          refresh.delete(form.get('refresh_token')!);
          return json(res, 200, issue(clientId));
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (url.pathname === '/mcp') {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (!bearer || !access.has(bearer)) {
          return json(res, 401, { error: 'invalid_token' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
        }
        state.calls++;
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const mcp = mcpServer();
        res.on('close', () => void transport.close().then(() => mcp.close()));
        await mcp.connect(transport);
        const raw = req.method === 'POST' ? await body(req) : '';
        return await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
      }
      json(res, 404, { error: 'not_found' });
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: 'server_error', error_description: (error as Error).message });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  return {
    url: `${base}/mcp`,
    base,
    issued,
    get calls() {
      return state.calls;
    },
    async approve(authorizationUrl: string) {
      const res = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = res.headers.get('location');
      if (res.status !== 302 || !location) throw new Error(`authorize answered ${res.status}: ${await res.text()}`);
      return location;
    },
    expireAccess: () => access.clear(),
    expireAll: () => {
      access.clear();
      refresh.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
