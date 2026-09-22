import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
