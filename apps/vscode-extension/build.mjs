// Bundles the extension host code and copies the dashboard's WebView build
// (apps/dashboard/dist/webview) into media/ so the .vsix is self-contained.
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  sourcemap: true,
  logLevel: 'info',
});

const webview = path.resolve('..', 'dashboard', 'dist', 'webview');
for (const file of ['webview.js', 'webview.css']) {
  const source = path.join(webview, file);
  if (!existsSync(source)) {
    console.error(`Missing ${source}. Build the dashboard first: pnpm --filter @acc/dashboard build`);
    process.exit(1);
  }
  cpSync(source, path.join('media', file));
}
console.log('Copied WebView assets into media/');
