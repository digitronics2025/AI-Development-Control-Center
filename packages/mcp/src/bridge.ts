import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * The Control Center as an MCP server (V2 plan §30). Agents (Claude Code,
 * Codex) launch this over stdio; it holds no policy and no secrets of its
 * own — every list and call is forwarded to the orchestrator with a tool
 * session token, and the orchestrator decides, runs, logs and redacts.
 *
 * Two ways to start it:
 *  - task session: the orchestrator sets ACC_TOOL_URL and ACC_TOOL_SESSION
 *    for the agent it launches (the token dies with that run);
 *  - operator: `node acc-mcp.js --repository <path> [--profile <id>]` from
 *    your own MCP client; it signs in with the local API token.
 */

export interface SessionTool {
  name: string;
  capability: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  level: number;
}

export interface BridgeImage {
  mime: string;
  /** Base64. */
  data: string;
}

export interface BridgeClient {
  list(): Promise<{ tools: SessionTool[]; session: Record<string, unknown> }>;
  call(capability: string, input: unknown): Promise<{ ok: boolean; text: string; images?: BridgeImage[] }>;
  find(query: string): Promise<{ text: string }>;
}

export function toolName(capability: string): string {
  return capability.replace(/\./g, '__').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

export function httpBridgeClient(baseUrl: string, token: string): BridgeClient {
  const request = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}/api/tool-session/${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(2 * 3600_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw new Error(json.error?.message ?? `Control Center answered ${res.status}`);
    return json;
  };
  return {
    list: async () => (await request('GET', 'tools')) as { tools: SessionTool[]; session: Record<string, unknown> },
    call: async (capability, input) => {
      const r = await request('POST', 'call', { capability, input });
      const images = Array.isArray(r.images) ? (r.images as Array<Record<string, unknown>>).filter((i) => typeof i.data === 'string' && /^image\/(png|jpeg)$/.test(String(i.mime))).map((i) => ({ mime: String(i.mime), data: String(i.data) })) : [];
      return { ok: Boolean(r.ok), text: String(r.text ?? r.summary ?? ''), images };
    },
    find: async (query) => ({ text: String((await request('POST', 'find', { query })).text ?? '') }),
  };
}

const META_TOOLS = [
  {
    name: 'acc_find_capability',
    description: 'Search every Control Center capability (not only the ones listed here) by keywords, e.g. "port owner", "d1 query", "android logcat". Shows whether each can run in this stage.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Keywords' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'acc_call_capability',
    description: 'Call a capability by id (e.g. "network.port_owner") when it is not in the tool list. The Control Center enables it if this stage is allowed to use it, and says why when it is not.',
    inputSchema: { type: 'object', properties: { capability: { type: 'string' }, input: { type: 'object' } }, required: ['capability'], additionalProperties: false },
  },
];

export function createBridgeServer(client: BridgeClient, version = '0.1.0'): Server {
  const server = new Server({ name: 'ai-development-control-center', version }, { capabilities: { tools: {} }, instructions: 'Tools of the AI Development Control Center. Prefer these over raw shell commands: they are routed to the right program, checked against the task policy, logged, and their secrets stay hidden.' });
  let byName = new Map<string, string>();

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await client.list();
    byName = new Map(tools.map((t) => [t.name || toolName(t.capability), t.capability]));
    return {
      tools: [
        ...tools.map((t) => ({ name: t.name || toolName(t.capability), title: t.title, description: `${t.description} (Level ${t.level})`, inputSchema: t.inputSchema as { type: 'object' } })),
        ...META_TOOLS.map((t) => ({ ...t, inputSchema: t.inputSchema as { type: 'object' } })),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (request.params.name === 'acc_find_capability') {
        const r = await client.find(String(args.query ?? ''));
        return { content: [{ type: 'text', text: r.text }] };
      }
      const capability = request.params.name === 'acc_call_capability' ? String(args.capability ?? '') : (byName.get(request.params.name) ?? request.params.name.replace(/__/g, '.'));
      const input = request.params.name === 'acc_call_capability' ? (args.input ?? {}) : args;
      const r = await client.call(capability, input);
      // A screenshot the tool took is shown to the model as a picture, not described.
      const pictures = (r.images ?? []).map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mime }));
      return { content: [{ type: 'text' as const, text: r.text }, ...pictures], isError: !r.ok };
    } catch (error) {
      return { content: [{ type: 'text', text: `Control Center error: ${(error as Error).message}` }], isError: true };
    }
  });
  return server;
}

function defaultDataDir(): string {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'AIDevControlCenter');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'ai-control-center');
}

function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

/** Operator mode: open a session with the local API token (the same user's own machine). */
async function operatorSession(argv: string[]): Promise<{ url: string; token: string }> {
  const dataDir = process.env.ACC_DATA_DIR ?? defaultDataDir();
  const runtime = path.join(dataDir, 'runtime.json');
  if (!existsSync(runtime)) throw new Error(`The Control Center is not running (no ${runtime})`);
  const { url } = JSON.parse(readFileSync(runtime, 'utf8')) as { url: string };
  const master = readFileSync(path.join(dataDir, 'auth-token'), 'utf8').trim();
  const repository = argValue(argv, '--repository') ?? process.cwd();
  const res = await fetch(`${url}/api/tool-sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${master}`, 'content-type': 'application/json', host: new URL(url).host },
    body: JSON.stringify({ repository, profile: argValue(argv, '--profile') ?? undefined }),
  });
  const json = (await res.json()) as { token?: string; error?: { message: string } };
  if (!res.ok || !json.token) throw new Error(json.error?.message ?? `Could not open a session (${res.status})`);
  return { url, token: json.token };
}

export async function runBridge(argv = process.argv.slice(2)): Promise<void> {
  const session = process.env.ACC_TOOL_SESSION && process.env.ACC_TOOL_URL ? { url: process.env.ACC_TOOL_URL, token: process.env.ACC_TOOL_SESSION } : await operatorSession(argv);
  const server = createBridgeServer(httpBridgeClient(session.url, session.token));
  await server.connect(new StdioServerTransport());
}
