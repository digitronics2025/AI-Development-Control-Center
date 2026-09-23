import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    include: ['test/**/*.test.ts'],
    // Each file runs its own Workers runtime (wrangler dev); keep them sequential.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
