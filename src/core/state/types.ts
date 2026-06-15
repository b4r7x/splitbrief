import type { Task, TaskId } from '../schemas/task.js';
import type { QueuedMessage } from '../schemas/workflow.js';
import type { RecoveryAction } from '../schemas/enums.js';
import type { RecoveryIssue } from '../schemas/recovery.js';

export type StateAction =
  | { type: 'START' }
  | { type: 'START_QUICK'; tasks: Task[] }
  | { type: 'START_INSTANT'; tasks: Task[] }
  | { type: 'RESEARCH_DONE' }
  | { type: 'SPEC_DONE' }
  | { type: 'APPROVE_SPEC' }
  | { type: 'REJECT_SPEC' }
  | { type: 'PLAN_DONE'; tasks: Task[] }
  | { type: 'REJECT_PLAN' }
  | { type: 'BRIEFS_READY'; tasks: Task[] }
  | { type: 'APPROVE_BRIEFS' }
  | { type: 'REJECT_BRIEFS' }
  | { type: 'SPEC_CLARIFY_START' }
  | { type: 'SPEC_CLARIFY_DONE' }
  | { type: 'CONSTITUTION_CHECK_PASS' }
  | { type: 'CONSTITUTION_CHECK_FAIL' }
  | { type: 'ANALYZE_START' }
  | { type: 'ANALYZE_DONE' }
  | { type: 'START_TASK'; taskId: TaskId }
  | { type: 'TASK_SENT' }
  | { type: 'VALIDATION_PASS' }
  | { type: 'VALIDATION_FAIL' }
  | { type: 'ESCALATE' }
  | { type: 'HINT_SUCCESS' }
  | { type: 'HINT_FAIL' }
  | { type: 'FULL_SUCCESS' }
  | { type: 'SKIP_TASK'; taskId: TaskId }
  | { type: 'UPDATE_TASK_CODE'; taskId: TaskId; code: string }
  | { type: 'CLEAR_TASK_CODE'; taskId: TaskId }
  | { type: 'ALL_DONE' }
  | { type: 'REVIEW_DONE' }
  | { type: 'CANCEL' }
  | { type: 'ABORT_TURN' }
  | { type: 'CONTINUE_TURN' }
  | { type: 'SET_PLANNER_SESSION_ID'; sessionId: string }
  | { type: 'REWIND_TO_SPEC'; comment?: string }
  | { type: 'REWIND_TO_PLAN'; comment?: string }
  | { type: 'RESET_TASK'; taskId: TaskId }
  | { type: 'CLEAR_REWIND_PENDING' }
  | { type: 'ENQUEUE_USER_MSG'; message: QueuedMessage }
  | { type: 'MARK_DELIVERED_NATIVE'; id: string }
  | { type: 'DRAIN_QUEUE' }
  | { type: 'CLEAR_QUEUE' }
  | { type: 'SET_PENDING_RECOVERY'; issue: RecoveryIssue }
  | { type: 'PAUSE_PENDING_RECOVERY' }
  | { type: 'MARK_RECOVERY_APPLYING'; action: RecoveryAction }
  | { type: 'RESOLVE_PENDING_RECOVERY' };

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
}
