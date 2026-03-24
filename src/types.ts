export type Phase =
  | 'idle'
  | 'researching'
  | 'specifying'
  | 'reviewing-spec'
  | 'planning'
  | 'reviewing-plan'
  | 'implementing'
  | 'validating-task'
  | 'escalating'
  | 'final-review'
  | 'complete';

export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'escalated' | 'skipped';

export interface Task {
  id: string;
  title: string;
  action: 'create' | 'modify';
  file: string;
  dependsOn: string[];
  description: string;
  signature?: string;
  currentCode?: string;
  tests: string[];
  constraints: string[];
  pattern?: string;
  typeDefs: string;
  implSteps: string[];
  status: TaskStatus;
}

export interface Config {
  planner: {
    tool: 'claude-code';
  };
  implementer: {
    provider: 'ollama' | 'lm-studio' | 'deepseek' | 'openrouter';
    model: string;
    apiBase: string;
    contextLength: number;
    temperature: number;
  };
  validation: {
    typecheck: boolean;
    lint: boolean;
    test: boolean;
    testCommand: string;
  };
  workflow: {
    autoApproveSpec: boolean;
    autoApprovePlan: boolean;
    maxRetries: number;
    commitPerTask: boolean;
  };
}

export interface ValidationResult {
  passed: boolean;
  stage: 'typecheck' | 'lint' | 'test';
  error?: string;
  output?: string;
}

export interface TokenUsage {
  plannerInput: number;
  plannerOutput: number;
  implementerInput: number;
  implementerOutput: number;
  escalationInput: number;
  escalationOutput: number;
}

export interface Summary {
  feature: string;
  totalTasks: number;
  completedByLocal: number;
  escalatedToOpus: number;
  skipped: number;
  failed: number;
  totalTime: number;
  tokenUsage: TokenUsage;
  estimatedCostSavings: string;
  escalationRate: number;
}

export interface WorkflowState {
  stateVersion: number;
  phase: Phase;
  feature: string;
  currentTaskIndex: number;
  attempt: number;
  tasks: Task[];
  completedTasks: string[];
  escalatedTasks: string[];
  skippedTasks: string[];
  failedTasks: string[];
  sessionId: string | null;
  startedAt: string;
  tokenUsage: TokenUsage;
}

export type StateAction =
  | { type: 'START'; feature: string }
  | { type: 'RESEARCH_DONE' }
  | { type: 'SPEC_DONE' }
  | { type: 'APPROVE_SPEC' }
  | { type: 'REJECT_SPEC' }
  | { type: 'PLAN_DONE'; tasks: Task[] }
  | { type: 'APPROVE_PLAN' }
  | { type: 'REJECT_PLAN' }
  | { type: 'TASK_SENT' }
  | { type: 'VALIDATION_PASS' }
  | { type: 'VALIDATION_FAIL' }
  | { type: 'ESCALATE' }
  | { type: 'HINT_SUCCESS' }
  | { type: 'HINT_FAIL' }
  | { type: 'FULL_SUCCESS' }
  | { type: 'FULL_FAIL' }
  | { type: 'ALL_DONE' }
  | { type: 'REVIEW_DONE' }
  | { type: 'CANCEL' }
  | { type: 'SET_SESSION_ID'; sessionId: string };

export interface Event {
  ts: number;
  type: string;
  taskId?: string;
  phase: Phase;
  data?: Record<string, unknown>;
}

export interface OrchestratorCallbacks {
  onPhaseChange: (phase: Phase) => void;
  onPlannerOutput: (text: string) => void;
  onImplementerOutput: (text: string) => void;
  onTaskStart: (task: Task, index: number, total: number) => void;
  onTaskComplete: (task: Task, method: 'local' | 'escalated') => void;
  onTaskRetry: (task: Task, attempt: number, error: string) => void;
  onTaskSkipped: (task: Task, reason: string) => void;
  onValidationResult: (task: Task, results: ValidationResult[]) => void;
  onApprovalNeeded: (type: 'spec' | 'plan', filePath: string) => Promise<boolean>;
  onExternalChanges: () => Promise<boolean>;
  onComplete: (summary: Summary) => void;
  onError: (error: string) => void;
}

export interface TokenBudget {
  system: number;
  taskBody: number;
  typeDefs: number;
  implSteps: number;
  codeContext: number;
  outputReserve: number;
  total: number;
  remaining: number;
}

export type CodeContext =
  | { mode: 'whole-file'; content: string }
  | { mode: 'function-level'; imports: string; targetFunction: string; otherExports: string[] };

export interface ProjectContext {
  name: string;
  dir: string;
  runtime: string;
  testCommand: string;
}
