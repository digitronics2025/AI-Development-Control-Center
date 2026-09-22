// Bundles the orchestrator and its internal workspace packages into one ESM
// file. better-sqlite3 stays external because it ships a native addon.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['better-sqlite3'],
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
});
