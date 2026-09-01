import type { Config } from '../../../src/core/schemas/config.js';
import type { WorkflowMode } from '../../../src/core/schemas/enums.js';

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

export function makeE2eScenarioConfig(
  mode: WorkflowMode,
  overrides: E2eScenarioConfigOverrides = {},
): Config {
  return {
    version: 3,
    planner: e2ePlanner,
    implementer: e2eImplementer,
    ...overrides,
    workflow: {
      mode,
      maxRetries: 3,
      persistTranscript: true,
      taskReview: 'none',
      compactionFormat: 'auto',
      ...overrides.workflow,
    },
    validation: {
      typecheck: false,
      lint: false,
      test: false,
      testCommand: 'npm test',
      ...overrides.validation,
    },
  };
}
