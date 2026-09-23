import { defineProject } from 'vitest/config';

// Unit tests for the dashboard's pure logic (transport, mode, node choice).
// Screens are covered by the Playwright suites in e2e/.
export default defineProject({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
