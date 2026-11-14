import type { MachineAction } from './types.js';
import { WORKFLOW_STATE_VERSION, type WorkflowState } from '../schemas/workflow/state.js';
import { ZERO_TOKEN_USAGE } from '../schemas/tokens.js';
import { assertNever } from '../../utils/type-guards.js';
import { transitionError } from './errors.js';
import { canApplyAction } from './phase-actions.js';
import { transitionTask } from './transitions/task.js';
import { transitionReview } from './transitions/review.js';
import { transitionApply } from './transitions/apply.js';
import { transitionInterrupt } from './transitions/interrupt.js';
import { transitionBriefEdits } from './transitions/brief-edits.js';
import { transitionQueue } from './transitions/queue.js';
import { transitionSeat } from './transitions/seat.js';

export function createInitialState(feature: string, now: Date = new Date()): WorkflowState {
  return {
    stateVersion: WORKFLOW_STATE_VERSION,
    stateRevision: 0,
    phase: 'idle',
    feature,
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    plannerSessionId: null,
    startedAt: now.toISOString(),
    tokenUsage: { ...ZERO_TOKEN_USAGE },
    awaitingContinue: false,
    messageQueue: [],
  };
}

export function transition(
  state: WorkflowState,
  action: MachineAction,
  opts: { now?: Date | undefined } = {},
): WorkflowState {
  const now = opts.now ?? new Date();
  // A closed run is the one terminal state: nothing reopens it, so every action
  // but the close itself is refused rather than silently mutating a finished run.
  if (state.closed !== undefined && action.type !== 'CLOSE_RUN' && action.type !== 'APPLY_UNDONE') {
    throw transitionError.runClosed(action.type);
  }
  if (!canApplyAction(state.phase, action.type)) {
    throw transitionError.invalidActionForPhase(state.phase, action.type);
  }

  switch (action.type) {
    case 'START':
      return { ...state, phase: 'planning' };

    case 'BEGIN_PLANNING':
      return { ...state, phase: 'planning' };

    case 'PLAN_DONE':
      return { ...state, phase: 'reviewing-plan', tasks: action.tasks };

    case 'PLAN_COMPILED':
      return { ...state, plan: action.plan, tasks: action.tasks, rewindPending: undefined };

    // A correction at the plan card stands until a plan compiles, so a replan that stops keeps it.
    case 'CORRECT_PLAN':
      return { ...state, rewindPending: { target: 'plan', comment: action.comment } };

    case 'BEGIN_IMPLEMENTATION':
      return {
        ...state,
        phase: 'implementing',
        currentTaskIndex: 0,
        attempt: 0,
      };

    case 'SET_PLANNER_CONVERSATION':
      return {
        ...state,
        phase:
          state.phase === 'implementing' ||
          state.phase === 'validating-task' ||
          state.phase === 'escalating'
            ? state.phase
            : action.conversation.call === 'research'
              ? 'researching'
              : action.conversation.call === 'spec'
                ? 'specifying'
                : 'planning',
        pendingPlannerConversation: action.conversation,
      };

    case 'CLEAR_PLANNER_CONVERSATION':
      return {
        ...state,
        userAnswers: [
          ...(state.userAnswers ?? []),
          ...(state.pendingPlannerConversation?.answers ?? []),
        ],
        pendingPlannerConversation: undefined,
        interruptedStep: undefined,
        awaitingContinue: false,
      };

    case 'SET_PLANNER_SESSION_ID':
      return { ...state, plannerSessionId: action.sessionId };

    case 'START_TASK':
    case 'TASK_SENT':
    case 'RESUME_TASK':
    case 'VALIDATION_PASS':
    case 'VALIDATION_FAIL':
    case 'ESCALATE':
    case 'SKIP_TASK':
    case 'UPDATE_TASK_CODE':
    case 'ALL_DONE':
    case 'COUNT_ATTEMPT':
    case 'RECORD_DISPATCH':
    case 'RECORD_CHECK_RESULTS':
      return transitionTask(state, action);

    case 'REVIEW_DONE':
    case 'RECORD_REVIEW':
    case 'RECORD_TRIAGE':
    case 'START_FIX_CYCLE':
    case 'REVIEW_CORRECTION':
    case 'QUEUE_TRIAGE':
    case 'START_SCHEDULED_REVIEW':
    case 'CLEAR_SCHEDULED_REVIEW':
      return transitionReview(state, action, now);

    case 'RECORD_WORKSPACE':
    case 'ACCEPT_AS_IS':
    case 'APPLY_REVIEW_START':
    case 'APPLY_RECHECK_START':
    case 'RECORD_APPLY_INTEGRATED':
    case 'BIND_APPLY_INTEGRATED':
    case 'RECORD_APPLY_RECHECK':
    case 'APPLY_START':
    case 'APPLY_DONE':
    case 'APPLY_RESTORED':
    case 'APPLY_UNDONE':
    case 'CLOSE_RUN':
      return transitionApply(state, action, now);

    case 'INTERRUPT_STEP':
    case 'RECORD_REJECT':
    case 'RESUME_STEP':
    case 'CONTINUE_STEP':
    case 'RESTORE_BRIEF_PARK':
      return transitionInterrupt(state, action, now);

    case 'RESET_TASK':
    case 'REPLACE_TASK':
    case 'INSERT_TASKS':
    case 'RECORD_CONSULT':
    case 'RECORD_DECISIONS':
    case 'RECORD_CORRECTION':
      return transitionBriefEdits(state, action, now);

    case 'DECIDE_FOR_ME':
    case 'ENQUEUE_USER_MSG':
    case 'MARK_INJECTING_NATIVE':
    case 'MARK_DELIVERED_NATIVE':
    case 'MARK_NATIVE_DELIVERY_FAILED':
    case 'MARK_POSSIBLE_DUPLICATE':
    case 'DRAIN_QUEUE':
    case 'CLEAR_QUEUE':
      return transitionQueue(state, action, now);

    case 'SET_SEAT_WAIT':
    case 'CLEAR_SEAT_WAIT':
    case 'SET_PENDING_RECOVERY':
    case 'MARK_RECOVERY_APPLYING':
    case 'RESOLVE_PENDING_RECOVERY':
    case 'RESTART_ATTEMPT_ON_SEAT':
    case 'RECORD_SEAT_SWITCH':
      return transitionSeat(state, action, now);

    default:
      return assertNever(action);
  }
}
