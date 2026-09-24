import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    projects: ['packages/*', 'apps/orchestrator', 'apps/vscode-extension', 'apps/cloud-control', 'apps/dashboard'],
  },
});
