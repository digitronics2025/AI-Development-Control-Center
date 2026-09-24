// Bundles the orchestrator and its internal workspace packages into one ESM
// file, plus the stdio MCP bridge agents launch (dist/acc-mcp.js). Native
// addons (better-sqlite3, node-pty) and packages that locate their own files
// at run time (playwright-core, axe-core) stay external.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

// The binary carries the commit it was built from, so /api/health can say
// exactly what is running (audit F-45). A build outside Git still works.
const gitOut = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const commit = gitOut(['rev-parse', 'HEAD']) || 'unknown';
const dirty = gitOut(['status', '--porcelain', '--untracked-files=no']) !== '';
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const stamp = { version: `${version}+${commit.slice(0, 7)}${dirty ? '.dirty' : ''}`, commit, dirty, builtAt: new Date().toISOString() };

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
  define: { __ACC_BUILD__: JSON.stringify(stamp) },
};

await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js' });
await build({ ...common, entryPoints: ['../../packages/mcp/src/bin.ts'], outfile: 'dist/acc-mcp.js' });
