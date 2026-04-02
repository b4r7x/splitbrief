import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'testing/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'testing/integration/**'],
    environment: 'node',
    globals: false,
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/cli.ts', 'src/app.tsx', 'src/types.ts', 'src/types/**'],
      thresholds: { statements: 40, branches: 30, functions: 40, lines: 40 },
    },
  },
});
