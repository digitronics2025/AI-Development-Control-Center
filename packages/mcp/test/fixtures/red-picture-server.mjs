// A real MCP server over stdio that returns one solid red 64×64 PNG, for `pnpm verify:agents --images`
// (does an agent CLI show an MCP image block to the model?). The picture is built here, not stored.
import { crc32, deflateSync } from 'node:zlib';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

export function solidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const server = new Server({ name: 'red-picture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'picture', description: 'Return a picture to look at', inputSchema: { type: 'object' } }] }));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [
    { type: 'text', text: 'Here is the picture.' },
    { type: 'image', data: solidPng(64, [255, 0, 0]).toString('base64'), mimeType: 'image/png' },
  ],
}));
await server.connect(new StdioServerTransport());
