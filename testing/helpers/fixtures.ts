import type { Config, PlannerConfig, Task, TokenUsage, ProjectContext } from '../../src/types.js';
import { taskId as brand } from '../../src/core/types/workflow.js';

export function makeConfig(overrides?: Omit<Partial<Config>, 'implementer' | 'planner' | 'validation' | 'workflow'> & { implementer?: Partial<Config['implementer']>; planner?: PlannerConfig; validation?: Partial<Config['validation']>; workflow?: Partial<Config['workflow']> }): Config {
  const base: Config = {
    planner: overrides?.planner ?? { kind: 'cli', tool: 'claude-code' },
    implementer: {
      kind: 'api',
      tool: 'ollama',
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
      commitStrategy: 'none',
      mode: 'standard',
      ...overrides?.workflow,
    },
  };
  if (overrides?.theme !== undefined) base.theme = overrides.theme;
  if (overrides?.shikiTheme !== undefined) base.shikiTheme = overrides.shikiTheme;
  if (overrides?.sessions !== undefined) base.sessions = overrides.sessions;
  return base;
}

type TaskOverrides = Omit<Partial<Task>, 'id' | 'dependsOn'> & {
  id?: string;
  dependsOn?: string[];
};

export function makeTask(overrides?: TaskOverrides): Task {
  const { id, dependsOn, ...rest } = overrides ?? {};
  return {
    id: brand(id ?? 'T001'),
    title: 'Create hello module',
    action: 'create',
    file: 'src/hello.ts',
    dependsOn: (dependsOn ?? []).map(brand),
    description: 'Create a hello world module',
    tests: [],
    constraints: [],
    typeDefs: '',
    implementationSteps: [],
    status: 'pending',
    ...rest,
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
