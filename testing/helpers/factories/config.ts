import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../../../src/core/schemas/config.js';
import type { ApiImplementerConfig, ImplementerConfig } from '../../../src/core/schemas/implementer-config.js';
import type { PlannerConfig } from '../../../src/core/schemas/planner-config.js';
import type { ProjectContext } from '../../../src/core/types/state-actions.js';

const defaultApiImplementer: ApiImplementerConfig = {
  kind: 'api',
  provider: 'ollama',
  model: 'qwen2.5-coder:7b',
  apiBase: 'http://localhost:11434/v1',
  contextLength: 32768,
  temperature: 0.2,
};

export function makeConfig(overrides?: Omit<Partial<Config>, 'implementer' | 'planner' | 'validation' | 'workflow'> & { implementer?: Partial<ImplementerConfig>; planner?: PlannerConfig; validation?: Partial<Config['validation']>; workflow?: Partial<Config['workflow']> }): Config {
  const base: Config = {
    version: 2,
    planner: overrides?.planner ?? { kind: 'cli', tool: 'claude-code' },
    implementer: overrides?.implementer
      ? { ...defaultApiImplementer, ...overrides.implementer } as ImplementerConfig
      : defaultApiImplementer,
    validation: {
      typecheck: true,
      lint: true,
      test: true,
      testCommand: 'npm test',
      ...overrides?.validation,
    },
    workflow: {
      autoApproveSpec: false,
      autoApprovePlan: false,
      maxRetries: 3,
      commitStrategy: 'none',
      persistTranscript: true,
      mode: 'standard',
      ...overrides?.workflow,
    },
  };
  if (overrides?.theme !== undefined) base.theme = overrides.theme;
  if (overrides?.shikiTheme !== undefined) base.shikiTheme = overrides.shikiTheme;
  if (overrides?.sessions !== undefined) base.sessions = overrides.sessions;
  if (overrides?.escalation !== undefined) base.escalation = overrides.escalation;
  if (overrides?.codebase !== undefined) base.codebase = overrides.codebase;
  if (overrides?.hooks !== undefined) base.hooks = overrides.hooks;
  return base;
}

export function makeNoValidationConfig(overrides?: Parameters<typeof makeConfig>[0]): Config {
  return makeConfig({
    ...overrides,
    validation: { typecheck: false, lint: false, test: false, testCommand: 'noop', ...overrides?.validation },
  });
}

export const defaultContext: ProjectContext = {
  name: 'test-project',
  dir: join(tmpdir(), `diptych-test-${process.pid}`),
  runtime: 'Node.js 22',
  testCommand: 'npm test',
};
