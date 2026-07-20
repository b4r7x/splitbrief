import { defineConfig } from 'vitest/config';

const coverageReportsDirectory = process.env.DIPTYCH_COVERAGE_DIR ?? 'coverage/manual';

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.{ts,tsx}',
      'scripts/**/*.test.{ts,tsx}',
      'testing/integration/**/*.test.{ts,tsx}',
      'testing/helpers/**/*.test.{ts,tsx}',
      'testing/visual/**/*.test.{ts,tsx}',
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
      reportsDirectory: coverageReportsDirectory,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/cli.ts',
        'src/app/root.tsx',
        'src/app/router.tsx',
        'src/app/provider.tsx',
        'src/app/layout.tsx',
        'src/app/overlays/editor.tsx',
        'src/features/editor/use-editor-keys.ts',
        'src/features/editor/editor-buffer-view.tsx',
        'src/features/editor/brief-field-editor.tsx',
        'src/features/editor/use-inline-edit-trigger.ts',
        'src/types/**',
      ],
      thresholds: { statements: 50, branches: 40, functions: 50, lines: 55 },
    },
  },
});
