// A tiny real MCP server over stdio for gateway tests.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'echo-fixture', version: '1.2.3' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, annotations: { readOnlyHint: true } },
    { name: 'fail', description: 'Always fails', inputSchema: { type: 'object' } },
    { name: 'env', description: 'Report whether FIXTURE_TOKEN is set', inputSchema: { type: 'object' } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'echo') return { content: [{ type: 'text', text: `echo: ${req.params.arguments?.text}` }] };
  if (req.params.name === 'env') return { content: [{ type: 'text', text: `token=${process.env.FIXTURE_TOKEN ?? 'unset'}` }] };
  return { content: [{ type: 'text', text: 'it failed' }], isError: true };
});
await server.connect(new StdioServerTransport());
