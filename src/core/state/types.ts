import type { Task, TaskId } from '../schemas/task.js';
import type { QueuedMessage, WorkflowState, PlannerConversation } from '../schemas/workflow.js';
import type { RecoveryAction, ReviewStatus } from '../schemas/enums.js';
import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import type { StepCut, StepRef } from '../schemas/run-step.js';

export type MachineAction = StateAction;

export type ResumeLoadResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'loaded'; readonly state: WorkflowState }
  | {
      readonly kind: 'invalid';
      readonly code: 'malformed' | 'future-version';
      readonly message: string;
    };

export type StateAction =
  | { type: 'START' }
  | { type: 'RESEARCH_DONE' }
  | { type: 'SPEC_DONE' }
  | { type: 'APPROVE_SPEC' }
  | { type: 'BEGIN_PLANNING' }
  | { type: 'PLAN_DONE'; tasks: Task[] }
  | { type: 'BRIEF_ADMISSION_OPENED' }
  | { type: 'BEGIN_IMPLEMENTATION' }
  | { type: 'SPEC_CLARIFY_START' }
  | { type: 'SPEC_CLARIFY_DONE' }
  | { type: 'CONSTITUTION_CHECK_PASS' }
  | { type: 'ANALYZE_START' }
  | { type: 'START_TASK'; taskId: TaskId }
  | { type: 'TASK_SENT' }
  | { type: 'VALIDATION_PASS' }
  | { type: 'VALIDATION_FAIL' }
  | { type: 'ESCALATE' }
  | { type: 'HINT_SUCCESS' }
  | { type: 'HINT_FAIL' }
  | { type: 'FULL_SUCCESS' }
  | { type: 'SKIP_TASK'; taskId: TaskId }
  | { type: 'UPDATE_TASK_CODE'; taskId: TaskId; code: string; codeByFile?: Record<string, string> }
  | { type: 'CLEAR_TASK_CODE'; taskId: TaskId }
  | { type: 'ALL_DONE' }
  | { type: 'REVIEW_DONE'; reviewStatus: ReviewStatus }
  | { type: 'REVIEW_FIX_START'; fixes: Record<string, string[]>; cycle: number }
  | { type: 'CLOSE_RUN'; at?: string }
  | {
      type: 'INTERRUPT_STEP';
      step: StepRef;
      source: 'user' | 'watchdog';
      /** Where the stop landed: inside the call, or between two briefs. */
      cut: StepCut;
      partialRef?: { kind: 'session-log'; index: number };
    }
  | { type: 'RESUME_STEP' }
  | { type: 'SET_PLANNER_CONVERSATION'; conversation: PlannerConversation }
  | { type: 'CLEAR_PLANNER_CONVERSATION' }
  | { type: 'SET_PLANNER_SESSION_ID'; sessionId: string }
  | { type: 'REWIND_TO_SPEC'; comment?: string }
  | { type: 'REWIND_TO_PLAN'; comment?: string }
  | { type: 'RESET_TASK'; taskId: TaskId }
  | { type: 'CLEAR_REWIND_PENDING' }
  | { type: 'ENQUEUE_USER_MSG'; message: QueuedMessage }
  | { type: 'MARK_INJECTING_NATIVE'; id: string; attempt?: number }
  | { type: 'MARK_DELIVERED_NATIVE'; id: string }
  | { type: 'MARK_NATIVE_DELIVERY_FAILED'; id: string }
  | { type: 'DRAIN_QUEUE'; ids?: string[] }
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
