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
    { name: 'picture', description: 'Return a picture (PNG), a GIF and text', inputSchema: { type: 'object' } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'echo') return { content: [{ type: 'text', text: `echo: ${req.params.arguments?.text}` }] };
  if (req.params.name === 'env') return { content: [{ type: 'text', text: `token=${process.env.FIXTURE_TOKEN ?? 'unset'}` }] };
  if (req.params.name === 'picture') {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1').toString('base64');
    const claimsPngButIsText = Buffer.from('not really a png').toString('base64');
    return {
      content: [
        { type: 'text', text: 'Here is the hero image' },
        { type: 'image', data: png, mimeType: 'image/png' },
        { type: 'image', data: gif, mimeType: 'image/gif' },
        { type: 'image', data: claimsPngButIsText, mimeType: 'image/png' },
      ],
    };
  }
  return { content: [{ type: 'text', text: 'it failed' }], isError: true };
});
await server.connect(new StdioServerTransport());
