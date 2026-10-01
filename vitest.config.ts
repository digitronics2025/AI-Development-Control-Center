import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Native shells and Workers runtimes also spawn processes. Match the
    // checked release gate without oversubscribing an operator's machine.
    maxWorkers: 2,
    globalSetup: ['./vitest.global-setup.ts'],
    projects: ['packages/*', 'apps/orchestrator', 'apps/vscode-extension', 'apps/cloud-control', 'apps/dashboard'],
  },
});
