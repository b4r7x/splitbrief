import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiImplementerConfig, Config, ImplementerConfig, PlannerConfig } from '../../src/core/types/config-options.js';
import type { ProjectContext, Task } from '../../src/core/types/state-actions.js';
import { taskId as brand } from '../../src/core/types/state-actions.js';
import type { Summary, TokenUsage } from '../../src/core/types/summary.js';
import type { Session } from '../../src/core/schemas/session.js';

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

export function makeSummary(overrides?: Partial<Summary>): Summary {
  return {
    feature: 'test feature',
    totalTasks: 2,
    completedByLocal: 1,
    escalatedToPlanner: 0,
    skipped: 0,
    failed: 0,
    totalTime: 10000,
    tokenUsage: makeUsage(),
    estimatedCostSavings: '~$0.00',
    escalationRate: 0,
    ...overrides,
  };
}

export function makeSession(overrides?: Partial<Omit<Session, 'status' | 'summary'>> & { status?: Session['status']; summary?: Session['summary'] }): Session {
  const status = overrides?.status ?? 'interrupted' as const;
  const base = {
    id: 'sess-1',
    feature: 'test feature',
    startedAt: 1_700_000_000,
    completedAt: null,
    stateVersion: 1,
    stateFile: null,
    ...overrides,
  };
  if (status === 'complete') {
    return { ...base, status, summary: overrides?.summary ?? makeSummary() };
  }
  return { ...base, status, summary: overrides?.summary ?? null };
}

export const defaultContext: ProjectContext = {
  name: 'test-project',
  dir: join(tmpdir(), `diptych-test-${process.pid}`),
  runtime: 'Node.js 22',
  testCommand: 'npm test',
};
