// Bundles the orchestrator and its internal workspace packages into one ESM
// file, plus the stdio MCP bridge agents launch (dist/acc-mcp.js). Native
// addons (better-sqlite3, node-pty) and packages that locate their own files
// at run time (playwright-core, axe-core) stay external.
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['better-sqlite3', 'node-pty', 'playwright-core', 'axe-core'],
  // CommonJS dependencies inside an ESM bundle need require/__dirname.
  banner: {
    js: [
      "import { createRequire as __accCreateRequire } from 'node:module';",
      "import { fileURLToPath as __accFileURLToPath } from 'node:url';",
      "import { dirname as __accDirname } from 'node:path';",
      'const require = __accCreateRequire(import.meta.url);',
      'const __filename = __accFileURLToPath(import.meta.url);',
      'const __dirname = __accDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
};

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js' });
await build({ ...common, entryPoints: ['../../packages/mcp/src/bin.ts'], outfile: 'dist/acc-mcp.js' });
