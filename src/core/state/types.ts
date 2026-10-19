import type { CheckResult, Task, TaskId } from '../schemas/task.js';
import type {
  QueuedMessage,
  WorkflowState,
  PlannerConversation,
  SeatSwitchRecord,
} from '../schemas/workflow.js';
import type { RecoveryAction, ReviewStatus } from '../schemas/enums.js';
import type { ConsultAnswer, ConsultReason, ConsultSeat } from '../schemas/consult.js';
import type { CrewSeatId } from '../crew/identity.js';
import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import type { Plan } from '../schemas/plan.js';
import type { TriageInput } from '../schemas/review.js';
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
  | { type: 'BEGIN_PLANNING' }
  | { type: 'PLAN_DONE'; tasks: Task[] }
  | { type: 'PLAN_COMPILED'; plan: Plan; tasks: Task[] }
  | { type: 'BEGIN_IMPLEMENTATION' }
  | { type: 'START_TASK'; taskId: TaskId }
  | { type: 'TASK_SENT' }
  | { type: 'RECORD_DISPATCH'; taskId: TaskId }
  | { type: 'RESUME_TASK' }
  | { type: 'VALIDATION_PASS' }
  | { type: 'VALIDATION_FAIL' }
  | { type: 'ESCALATE' }
  | { type: 'SKIP_TASK'; taskId: TaskId }
  | {
      type: 'UPDATE_TASK_CODE';
      taskId: TaskId;
      action: Task['action'];
      code?: string;
      codeByFile?: Record<string, string>;
      contextCodeByFile?: Record<string, string>;
    }
  | { type: 'ALL_DONE' }
  | { type: 'REVIEW_DONE'; reviewStatus: ReviewStatus; candidate?: Record<string, string> }
  | { type: 'RECORD_REVIEW'; review: NonNullable<WorkflowState['review']> }
  | { type: 'RECORD_REVIEW_CHECKS'; record: NonNullable<WorkflowState['reviewChecks']> }
  | { type: 'SET_PENDING_REVIEW_COMMANDS'; commands: string[] }
  | { type: 'RECORD_TRIAGE'; record: NonNullable<WorkflowState['triage']>[number] }
  | { type: 'START_FIX_CYCLE' }
  | { type: 'REVIEW_CORRECTION'; text: string }
  | {
      type: 'QUEUE_TRIAGE';
      inputs: NonNullable<WorkflowState['pendingTriage']>['inputs'];
      question?: NonNullable<WorkflowState['pendingTriage']>['question'];
      reviewAfterTaskId?: TaskId;
    }
  | { type: 'RECORD_WORKSPACE'; workspace: NonNullable<WorkflowState['workspace']> }
  | { type: 'ACCEPT_AS_IS'; findings: string[]; note?: string }
  | {
      type: 'APPLY_REVIEW_START';
      merged: { path: string; checkoutHunks: string }[];
      integrated?: NonNullable<WorkflowState['applyIntegrated']>;
      triage?: TriageInput[];
    }
  | { type: 'RECORD_APPLY_RECHECK'; failures: string[] }
  | { type: 'APPLY_START'; backupId: string }
  | { type: 'APPLY_DONE'; files: string[] }
  | { type: 'APPLY_RESTORED' }
  | { type: 'APPLY_UNDONE'; conflicts: string[] }
  | { type: 'CLOSE_RUN'; at?: string; as?: 'discarded'; patch?: string }
  | {
      type: 'INTERRUPT_STEP';
      step: StepRef;
      source: 'user' | 'watchdog' | 'seat';
      /** Where the stop landed: inside the call, or on a boundary — between two briefs, or at a gate. */
      cut: StepCut;
      partialRef?: { kind: 'session-log'; index: number };
      /** The declared files the cut brief had changed; recorded only when it changed any. */
      kept?: readonly string[];
    }
  | { type: 'RESUME_STEP' }
  /** A reject put back these paths: the stop no longer keeps them. */
  | { type: 'RECORD_REJECT'; removed: readonly string[] }
  | {
      type: 'RESTORE_BRIEF_PARK';
      step: Extract<StepRef, { kind: 'brief' }>;
      source: 'user' | 'watchdog' | 'seat';
      at: string;
    }
  | { type: 'SET_PLANNER_CONVERSATION'; conversation: PlannerConversation }
  | { type: 'CLEAR_PLANNER_CONVERSATION' }
  | { type: 'SET_PLANNER_SESSION_ID'; sessionId: string | null }
  | { type: 'RESET_TASK'; taskId: TaskId }
  | { type: 'REPLACE_TASK'; taskId: TaskId; task: Task }
  | { type: 'INSERT_TASKS'; parentId: TaskId | null; afterTaskId?: TaskId; tasks: Task[] }
  | {
      type: 'RECORD_CONSULT';
      taskId: TaskId;
      revision: number;
      reason: ConsultReason;
      answer: ConsultAnswer;
      /** The seat that answered. */
      seat: ConsultSeat;
    }
  | { type: 'CONFIRM_DECISIONS'; taskId: TaskId; decisions: { what: string; why: string }[] }
  | { type: 'RECORD_CORRECTION'; taskId: TaskId; text: string }
  | { type: 'COUNT_ATTEMPT'; taskId: TaskId }
  | { type: 'COUNT_PLANNER_CALL' }
  | { type: 'CLEAR_CARRIED_FAILURE'; taskId: TaskId }
  | {
      type: 'GRANT_ALLOWANCE';
      target: 'lineage' | 'planner';
      taskId: TaskId | null;
      note: string;
      failingOutput?: string;
    }
  | { type: 'START_SCHEDULED_REVIEW'; afterTaskId: TaskId }
  | { type: 'CLEAR_SCHEDULED_REVIEW' }
  | { type: 'SET_TASK_INPUT_HASHES'; taskId: TaskId; inputHashes: Record<string, string> }
  | { type: 'RECORD_CHECK_RESULTS'; taskId: TaskId; results: CheckResult[] }
  | { type: 'SET_SEAT_WAIT'; seat: CrewSeatId; resetAt: string }
  | { type: 'CLEAR_SEAT_WAIT' }
  | { type: 'CORRECT_PLAN'; comment: string }
  | { type: 'ENQUEUE_USER_MSG'; message: QueuedMessage }
  | { type: 'MARK_INJECTING_NATIVE'; id: string; attempt?: number }
  | { type: 'MARK_DELIVERED_NATIVE'; id: string; via?: 'mid-call' }
  | { type: 'MARK_NATIVE_DELIVERY_FAILED'; id: string }
  | { type: 'MARK_POSSIBLE_DUPLICATE'; id: string }
  | {
      type: 'DRAIN_QUEUE';
      ids?: string[];
      destination?: 'implementer' | 'reviewer';
      via?: 'mid-call';
    }
  | { type: 'CLEAR_QUEUE' }
  | { type: 'SET_PENDING_RECOVERY'; issue: RecoveryIssue }
  | { type: 'MARK_RECOVERY_APPLYING'; action: RecoveryAction }
  | { type: 'RESOLVE_PENDING_RECOVERY' }
  | { type: 'RESTART_ATTEMPT_ON_SEAT'; taskId: TaskId }
  | ({ type: 'RECORD_SEAT_SWITCH' } & Omit<SeatSwitchRecord, 'ts'>);

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
  /** The run's selected skills, rendered once and carried by every seat call. */
  skillsContext?: string | undefined;
  /** Where the run's global skills live: an implementer in isolation may read them, never write. */
  skillRoots?: readonly string[] | undefined;
}
