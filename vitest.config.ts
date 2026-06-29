import { defineConfig } from 'vitest/config';

const coverageReportsDirectory = process.env.DIPTYCH_COVERAGE_DIR ?? `coverage/run-${process.pid}`;

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.{ts,tsx}',
      'scripts/**/*.test.{ts,tsx}',
      'testing/integration/**/*.test.{ts,tsx}',
      'testing/helpers/**/*.test.{ts,tsx}',
      'evals/eval.test.ts',
    ],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
    pool: 'forks',
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      // Vitest writes raw coverage to reportsDirectory/.tmp; isolate concurrent
      // coverage invocations so one run cannot delete another run's temp files.
      reportsDirectory: coverageReportsDirectory,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/cli.ts',
        'src/app/root.tsx',
        'src/app/router.tsx',
        'src/app/provider.tsx',
        'src/app/layout.tsx',
        'src/types/**',
      ],
      thresholds: { statements: 50, branches: 40, functions: 50, lines: 55 },
    },
  },
});
