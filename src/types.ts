export type Screen = 'home' | 'workflow' | 'summary';
export const ALL_SCREENS: Screen[] = ['home', 'workflow', 'summary'];

export type ThemeMode = 'terminal' | 'mono';

export type InputMode = 'normal' | 'review' | 'question';

export interface Session {
  id: string;
  feature: string;
  startedAt: number;
  completedAt: number | null;
  status: 'complete' | 'interrupted' | 'failed';
  summary: Summary | null;
  stateVersion: number;
  stateFile: string | null;
}

export type RouteData =
  | { screen: 'home' }
  | { screen: 'workflow'; feature: string; resumeState?: WorkflowState }
  | { screen: 'summary'; summary: Summary };

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

export type PlannerTool = 'claude-code' | 'codex' | 'opencode' | 'aider' | 'agent-sdk' | 'shell';

export type OutputFormat = 'stream-json' | 'jsonl' | 'text';

export interface Config {
  planner: {
    tool: PlannerTool;
    model?: string;
    apiKey?: string;
    apiBase?: string;
    command?: string;
    args?: string[];
    outputFormat?: OutputFormat;
  };
  implementer: {
    provider: string;
    model: string;
    apiBase: string;
    contextLength: number;
    temperature: number;
    apiKey?: string;
    type?: 'api' | 'shell' | 'agent';
    command?: string;
    args?: string[];
    outputFormat?: OutputFormat;
    timeout?: number;
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
  theme?: ThemeMode;
  shikiTheme?: string;
  sessions?: { scope?: 'project' | 'global' };
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

export interface TaskTokenUsage {
  taskId: string;
  taskTitle: string;
  method: 'local' | 'escalated-hint' | 'escalated-full' | 'failed' | 'skipped';
  implementerTokens: number;
  escalationTokens: number;
  retryCount: number;
}

export interface CostBreakdown {
  hypotheticalCost: number;
  actualPlannerCost: number;
  actualImplementerCost: number;
  totalActualCost: number;
  savingsAmount: number;
  savingsPercentage: number;
  localCompletionRate: number;
}

export interface Summary {
  feature: string;
  totalTasks: number;
  completedByLocal: number;
  escalatedToPlanner: number;
  skipped: number;
  failed: number;
  totalTime: number;
  tokenUsage: TokenUsage;
  estimatedCostSavings: string;
  escalationRate: number;
  taskBreakdown?: TaskTokenUsage[];
  costBreakdown?: CostBreakdown;
  plannerName?: string;
  implementerName?: string;
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

export type TuiEvent =
  | { type: 'planner-status'; ts: number; phase: string; status: 'running' | 'done'; summary?: string; duration?: number }
  | { type: 'planner-text'; ts: number; text: string }
  | { type: 'task-start'; ts: number; taskId: string; title: string; index: number; total: number; file: string; action: 'create' | 'modify' }
  | { type: 'task-complete'; ts: number; taskId: string; title: string; method: 'local' | 'escalated'; retries: number; duration: number }
  | { type: 'task-skipped'; ts: number; taskId: string; title: string; reason: string }
  | { type: 'implementer-generate'; ts: number; status: 'running' | 'done' | 'failed'; model?: string; file?: string; linesAdded?: number; linesRemoved?: number; diff?: string; duration?: number }
  | { type: 'validate'; ts: number; status: 'running' | 'done'; passed: boolean; stages: { tsc: boolean; lint: boolean; test: boolean }; error?: string; duration?: number }
  | { type: 'retry'; ts: number; taskId: string; attempt: number; maxRetries: number }
  | { type: 'escalate'; ts: number; tier: 1 | 2; hint?: string }
  | { type: 'git-commit'; ts: number; message: string }
  | { type: 'error'; ts: number; message: string };

export interface OrchestratorCallbacks {
  onEvent: (event: TuiEvent) => void;
  onApprovalNeeded: (type: 'spec' | 'plan', filePath: string) => Promise<{ approved: boolean; comment?: string }>;
  onExternalChanges: () => Promise<boolean>;
  onQuestionAsked?: (question: import('./engine/question-parser.js').ClarificationQuestion, num: number, total: number) => Promise<string>;
  onComplete: (summary: Summary) => void;
}

export type OverlayType = 'none' | 'help' | 'command-palette' | 'picker' | 'skills';

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  path: string;
  scope: 'global' | 'project';
}

export interface SlashCommandDef {
  name: string;
  label?: string;
  description: string;
  shortcut?: string | null;
  validScreens: Screen[];
  handler: () => void;
}

export interface CommandContext {
  openOverlay: (type: OverlayType) => void;
  closeOverlay: () => void;
  showStatus: () => void;
  quit: () => void;
}

export interface CommandPaletteItem {
  label: string;
  description: string;
  shortcut: string | null;
  action: () => void;
  availableOn: Screen[];
}
