import { defineConfig, type TestProjectInlineConfiguration } from 'vitest/config';

const coverageReportsDirectory = process.env.SPLITBRIEF_COVERAGE_DIR ?? 'coverage/manual';
const underCoverage = process.env.SPLITBRIEF_COVERAGE_DIR !== undefined;

// Run isolation writes its worktrees under the user state directory; every
// suite gets a throwaway one so a test run never touches the operator's.
const stateHomeSetup = './testing/helpers/state-home.ts';
const waitBudgetSetup = './testing/helpers/wait-budget.ts';

const workflowScreenIntegration = [
  'testing/integration/ui/workflow-key-ownership.test.tsx',
  'testing/integration/ui/workflow-lifecycle.test.tsx',
  'testing/integration/ui/workflow-review-editing.test.tsx',
  'testing/integration/ui/workflow-readiness-persistence.test.tsx',
] as const;

const sharedTestSettings = {
  setupFiles: [stateHomeSetup, waitBudgetSetup],
  environment: 'node',
  globals: false,
  // Coverage instrumentation + fork contention regularly blows past a
  // 10s budget on the full 1,000-file run; 30s keeps a stuck test visible
  // while letting real-timer and subprocess tests survive a loaded box.
  testTimeout: underCoverage ? 40_000 : 30_000,
  hookTimeout: underCoverage ? 60_000 : 30_000,
  pool: 'forks',
  maxWorkers: 4,
} satisfies TestProjectInlineConfiguration['test'];

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
          ...sharedTestSettings,
          name: 'unit',
          include: [
            'src/**/*.test.{ts,tsx}',
            'scripts/**/*.test.{ts,tsx}',
            'testing/{architecture,ci,compat,docs,helpers,rebrand,visual}/**/*.test.{ts,tsx}',
            // Helpers only — testing/e2e/scenarios is the replay and live tier that
            // `npm run test:e2e` and `npm run test:e2e:live` own.
            'testing/e2e/helpers/**/*.test.{ts,tsx}',
            'evals/*.test.{ts,tsx}',
          ],
          exclude: ['node_modules', 'dist', '**/*.integration.test.{ts,tsx}'],
        },
      },
      {
        test: {
          ...sharedTestSettings,
          name: 'integration',
          include: [
            'testing/integration/**/*.test.{ts,tsx}',
            'src/**/*.integration.test.{ts,tsx}',
            'scripts/**/*.integration.test.{ts,tsx}',
            'testing/{architecture,ci,compat,docs,helpers,rebrand,visual}/**/*.integration.test.{ts,tsx}',
            'testing/e2e/helpers/**/*.integration.test.{ts,tsx}',
            'evals/*.integration.test.{ts,tsx}',
          ],
          exclude: ['node_modules', 'dist', ...workflowScreenIntegration],
        },
      },
      {
        test: {
          name: 'workflow-screen',
          include: [...workflowScreenIntegration],
          exclude: ['node_modules', 'dist'],
          setupFiles: [stateHomeSetup, waitBudgetSetup],
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
