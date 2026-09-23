import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { createBridgeServer, McpGateway, toolName, type BridgeClient, type McpServerConfig } from '../src/index.js';

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
    expect(health.tools.map((t) => t.name)).toEqual(['echo', 'fail', 'env']);
    expect(health.tools[0]!.readOnlyHint).toBe(true);
  });

  it('calls tools, reports tool errors, passes configured env and reuses the connection', async () => {
    expect(await gateway.callTool(fixture, 'echo', { text: 'hi' })).toMatchObject({ ok: true, text: 'echo: hi' });
    expect(await gateway.callTool(fixture, 'fail', {})).toMatchObject({ ok: false, isError: true });
    const env = await gateway.callTool(fixture, 'env', {});
    expect(env.text).toMatch(/^token=/);
    expect(env.text).not.toContain('unset');
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
});
