import type { Task, TaskId } from '../schemas/task.js';
import type { QueuedMessage, WorkflowState } from '../schemas/workflow.js';
import type { RecoveryAction } from '../schemas/enums.js';
import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import type { BriefReadinessDecision } from '../schemas/brief-recovery/attempt.js';
import type { BriefRecoveryV1 } from '../schemas/brief-recovery/document.js';
import type { BriefGenerationRef, TaskExecutionPermit } from '../schemas/brief-owner.js';
import type { SessionRef } from '../types/session-ref.js';

export type BriefAdmissionStateAction = {
  type: 'BRIEF_ADMISSION_OPENED';
  briefRecovery: BriefRecoveryV1;
};

export type MachineAction = StateAction | BriefAdmissionStateAction;

export type StateAuthorityCandidate = {
  readonly kind: 'candidate';
  readonly sessionId: string;
  readonly ownerId: string;
  readonly pid: number;
  readonly processStart: string;
  readonly runId: string;
  readonly acquisitionId: string;
  readonly fence: number;
  readonly stateRevision: number;
  readonly stateDigest: null;
};

export type ResumeReadPermit = {
  readonly kind: 'read-only-permit';
  readonly sessionId: string;
  readonly acquisitionId: string;
  readonly rawStateDigest: string | null;
};

export type StateAuthorityReceipt = {
  readonly kind: 'usable';
  readonly sessionId: string;
  readonly ownerId: string;
  readonly pid: number;
  readonly processStart: string;
  readonly runId: string;
  readonly acquisitionId: string;
  readonly fence: number;
  readonly stateRevision: number;
  readonly stateDigest: string;
};

export type ResumeLoadAuthority =
  | {
      readonly kind: 'fenced';
      readonly receipt: StateAuthorityReceipt;
      readonly promotedFromVersion: 3 | null;
    }
  | { readonly kind: 'read-only'; readonly permit: ResumeReadPermit };

export type ResumeLoadInput = {
  readonly ref: SessionRef;
  readonly authority: ResumeLoadAuthority;
};

export type ResumeLoadResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'loaded'; readonly state: WorkflowState; readonly migrated: boolean }
  | {
      readonly kind: 'invalid';
      readonly code: 'malformed' | 'future-version';
      readonly message: string;
    };

export type StateAuthorityAcquisitionResult =
  | ResumeLoadAuthority
  | { readonly kind: 'new-workflow'; readonly candidate: StateAuthorityCandidate };

export type StateAction =
  | { type: 'START' }
  | { type: 'RESEARCH_DONE' }
  | { type: 'SPEC_DONE' }
  | { type: 'APPROVE_SPEC' }
  | { type: 'REJECT_SPEC' }
  | { type: 'PLAN_DONE'; tasks: Task[] }
  | { type: 'REJECT_PLAN' }
  | {
      type: 'BEGIN_IMPLEMENTATION';
      generation: BriefGenerationRef;
      permit: TaskExecutionPermit;
    }
  | { type: 'RECORD_BRIEF_READINESS'; decision: BriefReadinessDecision }
  | { type: 'REJECT_BRIEFS' }
  | { type: 'SPEC_CLARIFY_START' }
  | { type: 'SPEC_CLARIFY_DONE' }
  | { type: 'CONSTITUTION_CHECK_PASS' }
  | { type: 'CONSTITUTION_CHECK_FAIL' }
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
  | { type: 'MARK_INJECTING_NATIVE'; id: string; attempt?: number }
  | { type: 'MARK_DELIVERED_NATIVE'; id: string }
  | { type: 'MARK_NATIVE_DELIVERY_FAILED'; id: string }
  | { type: 'DRAIN_QUEUE' }
  | { type: 'CLEAR_QUEUE' }
  | { type: 'SET_PENDING_RECOVERY'; issue: RecoveryIssue }
  | { type: 'PAUSE_PENDING_RECOVERY' }
  | { type: 'MARK_RECOVERY_APPLYING'; action: RecoveryAction }
  | { type: 'ACKNOWLEDGE_BUDGET_PAUSE'; cost: number }
  | { type: 'ABORT_PENDING_RECOVERY' }
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
