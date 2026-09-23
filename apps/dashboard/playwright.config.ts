import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const port = Number(process.env.ACC_E2E_PORT ?? 4391);
const dataRoot = path.join(os.tmpdir(), `acc-e2e-${port}`);
process.env.ACC_E2E_DATA_ROOT = dataRoot;

/**
 * End-to-end suite against the real orchestrator (simulated agents) serving
 * the built dashboard. Run `pnpm build` first; `pnpm e2e` then starts the
 * demo server with seeded tasks.
 */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // Real Chrome, as on the operator's machine; falls back to bundled Chromium in CI via PW_CHANNEL=chromium.
    channel: process.env.PW_CHANNEL ?? 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `node ../../scripts/demo.mjs --port ${port} --data "${dataRoot}"`,
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    env: { ACC_SIM_DELAY_MS: '400' },
  },
});
