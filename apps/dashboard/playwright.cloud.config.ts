import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const cloudPort = Number(process.env.ACC_CLOUD_E2E_PORT ?? 4395);
const nodePort = Number(process.env.ACC_CLOUD_E2E_NODE_PORT ?? 4396);
const root = path.join(os.tmpdir(), `acc-cloud-e2e-${cloudPort}`);
process.env.ACC_CLOUD_E2E_ROOT = root;
process.env.ACC_CLOUD_E2E_PORT = String(cloudPort);
process.env.ACC_CLOUD_E2E_NODE_PORT = String(nodePort);

/**
 * Cloud-mode end-to-end suite (docs/systems/cloud-control.md): the Worker in
 * the Workers runtime with local D1/R2/Durable Objects, the real orchestrator
 * (simulated agents, seeded demo data) paired as an execution node through
 * the relay, and the dashboard served by the Worker behind a test Access
 * identity. Run `pnpm build` first.
 */
export default defineConfig({
  testDir: './e2e-cloud',
  globalSetup: './e2e-cloud/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-cloud' }]],
  use: {
    baseURL: `http://127.0.0.1:${cloudPort}`,
    channel: process.env.PW_CHANNEL ?? 'chrome',
    storageState: path.join(root, 'storage-state.json'),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
