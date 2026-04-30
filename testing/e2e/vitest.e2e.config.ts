import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['testing/e2e/scenarios/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 30_000,
    retry: 0,
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
  },
});
