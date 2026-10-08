import type { Config } from '../../../src/core/schemas/config.js';

const e2eApiKey =
  process.env.SPLITBRIEF_E2E_RECORD === '1'
    ? process.env.SPLITBRIEF_E2E_API_KEY
    : 'e2e-placeholder';

const e2eApiBase = process.env.SPLITBRIEF_E2E_API_BASE ?? 'http://localhost:11434/v1';

export const e2ePlanner = {
  kind: 'api',
  provider: 'custom-endpoint',
  service: 'custom-endpoint',
  offering: 'payg',
  apiBase: e2eApiBase,
  ...(e2eApiKey ? { apiKey: e2eApiKey } : {}),
  model: 'claude-sonnet-4-6',
} as const;

export const e2eImplementer = {
  kind: 'api',
  provider: 'custom-endpoint',
  service: 'custom-endpoint',
  offering: 'payg',
  apiBase: e2eApiBase,
  ...(e2eApiKey ? { apiKey: e2eApiKey } : {}),
  model: 'claude-haiku-4-5-20251001',
} as const;

type E2eScenarioConfigOverrides = Omit<
  Partial<Config>,
  'version' | 'planner' | 'implementer' | 'workflow' | 'validation'
> & {
  workflow?: Partial<Config['workflow']>;
  validation?: Partial<Config['validation']>;
};

export function makeE2eScenarioConfig(overrides: E2eScenarioConfigOverrides = {}): Config {
  return {
    version: 3,
    planner: e2ePlanner,
    implementer: e2eImplementer,
    ...overrides,
    workflow: {
      maxRetries: 3,
      compactionFormat: 'auto',
      ...overrides.workflow,
    },
    validation: {
      endChecks: false,
      // The replayed plans name `test` checks the fixture projects cannot run (prose, or no
      // test script); a command that exits 0 lets the scenarios measure the workflow itself.
      testCommand: 'node --version',
      ...overrides.validation,
    },
  };
}
