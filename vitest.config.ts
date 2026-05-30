import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.{ts,tsx}',
      'testing/integration/**/*.test.{ts,tsx}',
      'testing/helpers/**/*.test.{ts,tsx}',
      'evals/eval.test.ts',
    ],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/cli.ts', 'src/app.tsx', 'src/types.ts', 'src/types/**'],
      thresholds: { statements: 50, branches: 40, functions: 50, lines: 55 },
    },
  },
});
