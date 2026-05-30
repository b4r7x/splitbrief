import type { Config } from '../../../src/core/schemas/config.js';
import type { WorkflowMode } from '../../../src/core/schemas/enums.js';

const replayApiKey = process.env.DIPTYCH_E2E_RECORD === '1' ? undefined : 'e2e-placeholder';

const e2eApiBase = process.env.DIPTYCH_E2E_API_BASE ?? 'http://localhost:11434/v1';

export const e2ePlanner = {
  kind: 'api',
  provider: 'anthropic',
  apiBase: e2eApiBase,
  ...(replayApiKey ? { apiKey: replayApiKey } : {}),
  model: 'claude-sonnet-4-6',
} as const;

export const e2eImplementer = {
  kind: 'api',
  provider: 'anthropic',
  apiBase: e2eApiBase,
  ...(replayApiKey ? { apiKey: replayApiKey } : {}),
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
    version: 2,
    planner: e2ePlanner,
    implementer: e2eImplementer,
    ...overrides,
    workflow: {
      mode,
      commitStrategy: 'none',
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
