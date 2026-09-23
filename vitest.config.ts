import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/orchestrator', 'apps/vscode-extension', 'apps/cloud-control', 'apps/dashboard'],
  },
});
