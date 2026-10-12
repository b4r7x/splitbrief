import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'e2e',
    include: ['testing/e2e/scenarios/**/*.test.ts', 'testing/helpers/hermetic-env.test.ts'],
    exclude: [
      'node_modules',
      'dist',
      'testing/e2e/scenarios/live/**',
      'testing/e2e/scenarios/real-cli-planner-implementer-smoke.test.ts',
      ...(process.env.SPLITBRIEF_E2E_RECORD === '1' || process.env.SPLITBRIEF_REAL_CLI_E2E === '1'
        ? ['testing/helpers/hermetic-env.test.ts']
        : []),
    ],
    setupFiles: ['./testing/helpers/state-home.ts'],
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
