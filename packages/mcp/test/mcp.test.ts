import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBridgeServer, finishMcpSignIn, McpGateway, McpOAuthProvider, McpSignInRequired, startMcpSignIn, toolName, type BridgeClient, type McpOAuthState, type McpServerConfig } from '../src/index.js';
import { startOAuthMcpServer, type OAuthMcpFixture } from './fixtures/oauth-server.js';

const gateway = new McpGateway();
afterAll(() => gateway.close());

const fixture: McpServerConfig = {
  id: 'echo',
  name: 'Echo fixture',
  transport: 'stdio',
  command: process.execPath,
  args: [path.join(import.meta.dirname, 'fixtures', 'echo-server.mjs')],
  cwd: path.join(import.meta.dirname, '..'),
  env: { FIXTURE_TOKEN: ['fixture', 'value', '123'].join('-') },
  timeoutMs: 20_000,
};

describe('McpGateway (real stdio server)', () => {
  it('checks health and discovers tools with their hints', async () => {
    const health = await gateway.check(fixture);
    expect(health).toMatchObject({ ok: true, serverName: 'echo-fixture', serverVersion: '1.2.3', error: null });
    expect(health.tools.map((t) => t.name)).toEqual(['echo', 'fail', 'env', 'picture']);
    expect(health.tools[0]!.readOnlyHint).toBe(true);
  });

  it('calls tools, reports tool errors, passes configured env and reuses the connection', async () => {
    expect(await gateway.callTool(fixture, 'echo', { text: 'hi' })).toMatchObject({ ok: true, text: 'echo: hi' });
    expect(await gateway.callTool(fixture, 'fail', {})).toMatchObject({ ok: false, isError: true });
    const env = await gateway.callTool(fixture, 'env', {});
    expect(env.text).toMatch(/^token=/);
    expect(env.text).not.toContain('unset');
  });

  it('passes on PNG and JPEG pictures a tool returns, and only those', async () => {
    const r = await gateway.callTool(fixture, 'picture', {});
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Here is the hero image');
    expect(r.text).toContain('[image image/png]');
    expect(r.images).toHaveLength(1);
    expect(r.images[0]!.mime).toBe('image/png');
    expect(r.images[0]!.data.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect((await gateway.callTool(fixture, 'echo', { text: 'x' })).images).toEqual([]);
  });

  it("serves the images probe's red picture as a real 64×64 PNG (pnpm verify:agents --images)", async () => {
    const red = { ...fixture, id: 'red-picture', name: 'red', args: [path.join(import.meta.dirname, 'fixtures', 'red-picture-server.mjs')] };
    const r = await gateway.callTool(red, 'picture', {});
    expect(r.images).toHaveLength(1);
    const png = r.images[0]!.data;
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([64, 64]);
    const { inflateSync } = await import('node:zlib');
    const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8);
    expect([...inflateSync(idat).subarray(1, 4)]).toEqual([255, 0, 0]);
    await gateway.disconnect('red-picture');
  });

  it('reports a broken server as unhealthy instead of throwing', async () => {
    const health = await gateway.check({ ...fixture, id: 'broken', args: ['-e', 'process.exit(1)'] });
    expect(health.ok).toBe(false);
    expect(health.error).toBeTruthy();
  });
});

describe('Control Center MCP bridge', () => {
  it('lists session tools plus meta tools and forwards calls by capability', async () => {
    const calls: Array<[string, unknown]> = [];
    const fake: BridgeClient = {
      list: async () => ({ session: {}, tools: [{ name: toolName('network.port_owner'), capability: 'network.port_owner', title: 'Who is using a port', description: 'Port owner', inputSchema: { type: 'object' }, level: 1 }] }),
      call: async (capability, input) => {
        calls.push([capability, input]);
        return capability === 'fs.delete' ? { ok: false, text: 'Refused: needs approval' } : { ok: true, text: 'port 4317: node' };
      },
      find: async (query) => ({ text: `found ${query}` }),
    };
    const server = createBridgeServer(fake);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['network__port_owner', 'acc_find_capability', 'acc_call_capability']);
    const ok = await client.callTool({ name: 'network__port_owner', arguments: { port: 4317 } });
    expect(ok.isError).toBeFalsy();
    expect((ok.content as Array<{ text: string }>)[0]!.text).toBe('port 4317: node');
    const refused = await client.callTool({ name: 'acc_call_capability', arguments: { capability: 'fs.delete', input: { path: 'x', recursive: true } } });
    expect(refused.isError).toBe(true);
    expect(calls).toEqual([
      ['network.port_owner', { port: 4317 }],
      ['fs.delete', { path: 'x', recursive: true }],
    ]);
    const found = await client.callTool({ name: 'acc_find_capability', arguments: { query: 'logcat' } });
    expect((found.content as Array<{ text: string }>)[0]!.text).toBe('found logcat');
    await client.close();
  });

  it('shows a screenshot a tool took to the model as a picture', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const fake: BridgeClient = {
      list: async () => ({ session: {}, tools: [] }),
      call: async () => ({ ok: true, text: 'Opened pg-1', images: [{ mime: 'image/png', data: png }] }),
      find: async () => ({ text: '' }),
    };
    const server = createBridgeServer(fake);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.listTools();
    const r = await client.callTool({ name: 'acc_call_capability', arguments: { capability: 'browser.open', input: { url: 'http://localhost:5173' } } });
    expect(r.content).toEqual([
      { type: 'text', text: 'Opened pg-1' },
      { type: 'image', data: png, mimeType: 'image/png' },
    ]);
    await client.close();
  });
});

describe('McpGateway OAuth sign-in (stand-in authorization server)', () => {
  let remote: OAuthMcpFixture;
  let saved: McpOAuthState | null = null;
  const store = { load: () => saved, save: (state: McpOAuthState) => void (saved = JSON.parse(JSON.stringify(state)) as McpOAuthState) };
  const redirectUrl = 'http://127.0.0.1:4317/api/mcp/oauth/callback';
  const provider = (interactive: boolean, state?: string) => new McpOAuthProvider(store, { redirectUrl, interactive, state });
  const config = (): McpServerConfig => ({ id: 'remote', name: 'Remote fixture', transport: 'http', url: remote.url, oauth: provider(false), timeoutMs: 20_000 });

  beforeAll(async () => {
    remote = await startOAuthMcpServer();
  });
  afterAll(async () => {
    await gateway.disconnect('remote');
    await remote.close();
  });

  it('refuses to call before the operator signs in, without starting a sign-in by itself', async () => {
    await expect(gateway.callTool(config(), 'whoami', {})).rejects.toBeInstanceOf(McpSignInRequired);
    expect(saved?.tokens).toBeUndefined();
    expect(saved?.codeVerifier).toBeUndefined();
  });

  it('signs in with PKCE, keeps the tokens in the store, and calls the tool with them', async () => {
    const start = await startMcpSignIn(remote.url, provider(true, 'state-1'));
    if (start.authorized) throw new Error('expected a sign-in');
    const auth = new URL(start.authorizationUrl);
    expect(auth.origin + auth.pathname).toBe(`${remote.base}/authorize`);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('state')).toBe('state-1');
    expect(auth.searchParams.get('redirect_uri')).toBe(redirectUrl);
    expect(saved?.codeVerifier).toBeTruthy();
    // The operator approves in the browser; the callback gets the code back with the state.
    const back = new URL(await remote.approve(start.authorizationUrl));
    expect(back.searchParams.get('state')).toBe('state-1');
    await finishMcpSignIn(remote.url, provider(true), back.searchParams.get('code')!);
    expect(saved?.tokens?.access_token).toBe(remote.issued[0]);
    expect(saved?.codeVerifier).toBeUndefined();
    const r = await gateway.callTool(config(), 'whoami', {});
    expect(r).toMatchObject({ ok: true, text: 'signed in as the operator' });
    for (const secret of remote.issued) expect(JSON.stringify(r)).not.toContain(secret);
  });

  it('refreshes an expired access token on its own, and asks for a new sign-in when that fails too', async () => {
    remote.expireAccess();
    await gateway.disconnect('remote');
    const before = saved!.tokens!.access_token;
    expect(await gateway.callTool(config(), 'whoami', {})).toMatchObject({ ok: true });
    expect(saved!.tokens!.access_token).not.toBe(before);
    remote.expireAll();
    await gateway.disconnect('remote');
    await expect(gateway.callTool(config(), 'whoami', {})).rejects.toThrow(/Not signed in to Remote fixture: sign in again/);
    // A background call never starts a sign-in the operator did not ask for.
    expect(saved?.codeVerifier).toBeUndefined();
  });
});
