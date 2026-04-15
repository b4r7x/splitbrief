import type { z } from 'zod';
import type { WorkflowStateSchema } from './schemas/workflow.js';
import type { TaskSchema } from './schemas/task.js';

export type { Phase, TaskStatus } from './schemas/enums.js';
export { PHASES, TASK_STATUSES } from './schemas/enums.js';

export type TaskId = string & { readonly __brand: 'TaskId' };
export const taskId = (s: string): TaskId => s as TaskId;

export type Task = z.infer<typeof TaskSchema>;

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

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
  | { type: 'START_TASK'; taskId: TaskId }
  | { type: 'TASK_SENT' }
  | { type: 'VALIDATION_PASS' }
  | { type: 'VALIDATION_FAIL' }
  | { type: 'ESCALATE' }
  | { type: 'HINT_SUCCESS' }
  | { type: 'HINT_FAIL' }
  | { type: 'FULL_SUCCESS' }
  | { type: 'FULL_FAIL' }
  | { type: 'SKIP_TASK'; taskId: TaskId }
  | { type: 'UPDATE_TASK_CODE'; taskId: TaskId; code: string }
  | { type: 'ALL_DONE' }
  | { type: 'REVIEW_DONE' }
  | { type: 'CANCEL' }
  | { type: 'ABORT_TURN' }
  | { type: 'CONTINUE_TURN' }
  | { type: 'SET_PLANNER_SESSION_ID'; sessionId: string };

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
