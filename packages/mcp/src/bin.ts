// Entry point bundled as apps/orchestrator/dist/acc-mcp.js (the stdio MCP server agents launch).
import { runBridge } from './bridge.js';

runBridge().catch((error: unknown) => {
  process.stderr.write(`acc-mcp: ${(error as Error).message}\n`);
  process.exit(1);
});
