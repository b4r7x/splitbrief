import type { Config, Task, TokenUsage, ProjectContext, Summary, SidebarTask, TaskStatus } from '../../src/types.js';
import type { WorkflowViewState as HookWorkflowState } from '../../src/stores/workflow.js';

export function makeConfig(overrides?: Omit<Partial<Config>, 'implementer' | 'planner' | 'validation' | 'workflow'> & { implementer?: Partial<Config['implementer']>; planner?: Partial<Config['planner']>; validation?: Partial<Config['validation']>; workflow?: Partial<Config['workflow']> }): Config {
  const base: Config = {
    planner: { tool: 'claude-code', ...overrides?.planner },
    implementer: {
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
    implementationSteps: [],
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

export function makeHookWorkflowState(overrides?: Partial<Omit<HookWorkflowState, 'taskMap'>> & { taskMap?: Map<string, SidebarTask> }): HookWorkflowState {
  const defaults: HookWorkflowState = {
    events: [],
    phase: 'idle',
    currentTask: 0,
    totalTasks: 0,
    localCount: 0,
    escalatedCount: 0,
    reviewFilePath: null,
    taskMap: new Map(),
    tokenUsage: null,
    cancelled: false,
  };
  return { ...defaults, ...overrides, taskMap: overrides?.taskMap ?? defaults.taskMap };
}

export function makeSummary(overrides?: Partial<Summary>): Summary {
  return {
    feature: 'test feature',
    totalTasks: 3,
    completedByLocal: 2,
    escalatedToPlanner: 1,
    skipped: 0,
    failed: 0,
    totalTime: 30000,
    tokenUsage: {
      plannerInput: 1000,
      plannerOutput: 500,
      implementerInput: 2000,
      implementerOutput: 1000,
      escalationInput: 500,
      escalationOutput: 250,
    },
    estimatedCostSavings: '$0.50',
    escalationRate: 0.33,
    ...overrides,
  };
}

export function makeSidebarTask(overrides?: Partial<SidebarTask>): SidebarTask {
  return {
    id: 'T001',
    title: 'Test task',
    status: 'pending' as TaskStatus,
    ...overrides,
  };
}
