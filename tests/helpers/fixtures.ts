import type { Config, Task, TokenUsage, ProjectContext } from '../../src/types.js';

export function makeConfig(overrides?: Partial<Config> & { implementer?: Partial<Config['implementer']>; planner?: Partial<Config['planner']>; validation?: Partial<Config['validation']>; workflow?: Partial<Config['workflow']> }): Config {
  const base: Config = {
    planner: { tool: 'claude-code', ...overrides?.planner },
    implementer: {
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      apiBase: '',
      contextLength: 32768,
      temperature: 0.2,
      ...overrides?.implementer,
    },
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
      commitPerTask: true,
      ...overrides?.workflow,
    },
  };
  if (overrides?.theme !== undefined) base.theme = overrides.theme;
  if (overrides?.shikiTheme !== undefined) base.shikiTheme = overrides.shikiTheme;
  if (overrides?.sessions !== undefined) base.sessions = overrides.sessions;
  return base;
}

export function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'T001',
    title: 'Create hello module',
    action: 'create',
    file: 'src/hello.ts',
    dependsOn: [],
    description: 'Create a hello world module',
    tests: [],
    constraints: [],
    typeDefs: '',
    implSteps: [],
    status: 'pending',
    ...overrides,
  };
}

export function makeUsage(overrides?: Partial<TokenUsage>): TokenUsage {
  return {
    plannerInput: 0,
    plannerOutput: 0,
    implementerInput: 0,
    implementerOutput: 0,
    escalationInput: 0,
    escalationOutput: 0,
    ...overrides,
  };
}

export const defaultContext: ProjectContext = {
  name: 'test-project',
  dir: '/tmp/test-project',
  runtime: 'Node.js 22',
  testCommand: 'npm test',
};
