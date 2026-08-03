import { defineConfig } from 'vitest/config';

const coverageReportsDirectory = process.env.SPLITBRIEF_COVERAGE_DIR ?? 'coverage/manual';
const underCoverage = process.env.SPLITBRIEF_COVERAGE_DIR !== undefined;

const workflowScreenIntegration = [
  'testing/integration/ui/workflow-key-ownership.test.tsx',
  'testing/integration/ui/workflow-attached.test.tsx',
  'testing/integration/ui/workflow-lifecycle.test.tsx',
  'testing/integration/ui/workflow-review-editing.test.tsx',
  'testing/integration/ui/workflow-readiness-persistence.test.tsx',
] as const;

const coverage = {
  provider: 'v8' as const,
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
};

export default defineConfig({
  test: {
    coverage,
    projects: [
      {
        test: {
          name: 'default',
          include: [
            'src/**/*.test.{ts,tsx}',
            'scripts/**/*.test.{ts,tsx}',
            'testing/{architecture,ci,docs,rebrand}/**/*.test.{ts,tsx}',
            'testing/compat/**/*.test.{ts,tsx}',
            'testing/integration/**/*.test.{ts,tsx}',
            'testing/helpers/**/*.test.{ts,tsx}',
            'testing/visual/**/*.test.{ts,tsx}',
            'evals/eval.test.ts',
          ],
          exclude: ['node_modules', 'dist', ...workflowScreenIntegration],
          environment: 'node',
          globals: false,
          // Coverage instrumentation + fork contention regularly blows past the
          // interactive 10s budget; keep local `npm test` snappy.
          testTimeout: underCoverage ? 40_000 : 10_000,
          hookTimeout: underCoverage ? 60_000 : 10_000,
          pool: 'forks',
          maxWorkers: 4,
        },
      },
      {
        test: {
          name: 'workflow-screen',
          include: [...workflowScreenIntegration],
          exclude: ['node_modules', 'dist'],
          environment: 'node',
          globals: false,
          testTimeout: underCoverage ? 60_000 : 20_000,
          hookTimeout: underCoverage ? 60_000 : 20_000,
          pool: 'forks',
          maxWorkers: 1,
          fileParallelism: false,
        },
      },
    ],
  },
});
