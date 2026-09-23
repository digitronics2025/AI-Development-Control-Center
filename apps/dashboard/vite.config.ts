import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

function dataDir(): string {
  if (process.env.ACC_DATA_DIR) return process.env.ACC_DATA_DIR;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'AIDevControlCenter');
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'ai-control-center');
}

/**
 * Dev server only: inject the local orchestrator token the same way the
 * orchestrator does in production, and proxy API/WebSocket traffic to it.
 */
function devToken(): Plugin {
  return {
    name: 'acc-dev-token',
    apply: 'serve',
    transformIndexHtml(html) {
      const file = path.join(dataDir(), 'auth-token');
      const token = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
      return html.replace('</head>', `<meta name="acc-token" content="${token}"></head>`);
    },
  };
}

const orchestrator = `http://127.0.0.1:${process.env.ACC_PORT ?? 4317}`;

export default defineConfig(({ mode }) => {
  const webview = mode === 'webview';
  return {
    plugins: [react(), tailwindcss(), devToken()],
    base: webview ? './' : '/',
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        '/api': { target: orchestrator, changeOrigin: false },
        '/ws': { target: orchestrator.replace('http', 'ws'), ws: true },
      },
    },
    build: webview
      ? {
          // The VS Code extension loads fixed file names through asWebviewUri.
          outDir: 'dist/webview',
          emptyOutDir: true,
          cssCodeSplit: false,
          rollupOptions: {
            input: path.resolve(import.meta.dirname, 'src/webview-main.tsx'),
            output: { entryFileNames: 'webview.js', assetFileNames: 'webview[extname]', inlineDynamicImports: true },
          },
        }
      : { outDir: 'dist/web', emptyOutDir: true, sourcemap: true },
  };
});
