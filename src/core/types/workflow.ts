import type { TokenUsage } from './tokens.js';

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
  | { type: 'START_QUICK'; tasks: Task[] }
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

export interface TokenBudget {
  system: number;
  taskBody: number;
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
