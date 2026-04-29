import type { StateAction } from '../types/state-actions.js';
import type { WorkflowState } from '../schemas/workflow.js';
import type { TaskId } from '../schemas/task.js';
import type { TaskStatus } from '../schemas/enums.js';
import type { TokenUsage } from '../schemas/tokens.js';
import { assertNever } from '../../utils/type-guards.js';

export const CURRENT_STATE_VERSION = 3;

const zeroTokenUsage: TokenUsage = {
  plannerInput: 0,
  plannerOutput: 0,
  implementerInput: 0,
  implementerOutput: 0,
  escalationInput: 0,
  escalationOutput: 0,
};

export function createInitialState(feature: string): WorkflowState {
  return {
    stateVersion: CURRENT_STATE_VERSION,
    phase: 'idle',
    feature,
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    plannerSessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: { ...zeroTokenUsage },
    awaitingContinue: false,
    messageQueue: [],
  };
}

function setTaskStatus(state: WorkflowState, taskId: TaskId, status: TaskStatus): WorkflowState {
  return {
    ...state,
    tasks: state.tasks.map(t => t.id === taskId ? { ...t, status } : t),
  };
}

function advanceTask(state: WorkflowState, status: TaskStatus): WorkflowState {
  const currentId = state.tasks[state.currentTaskIndex]?.id;
  const withStatus = currentId ? setTaskStatus(state, currentId, status) : state;
  return {
    ...withStatus,
    phase: 'implementing',
    currentTaskIndex: state.currentTaskIndex + 1,
    attempt: 0,
  };
}

function markRecoveryApplying(state: WorkflowState, action: Extract<StateAction, { type: 'MARK_RECOVERY_APPLYING' }>): WorkflowState {
  if (!state.pendingRecovery) return state;
  return {
    ...state,
    pendingRecovery: {
      ...state.pendingRecovery,
      status: 'applying',
      selectedAction: action.action,
      selectedAt: action.selectedAt ?? new Date().toISOString(),
    },
  };
}

export function transition(state: WorkflowState, action: StateAction, maxRetries: number = 3): WorkflowState {
  switch (action.type) {
    case 'START':
      return { ...state, phase: 'researching' };

    case 'START_QUICK':
      return { ...state, phase: 'implementing', tasks: action.tasks, currentTaskIndex: 0, attempt: 0 };

    case 'START_INSTANT':
      return { ...state, phase: 'implementing', tasks: action.tasks, currentTaskIndex: 0, attempt: 0 };

    case 'RESEARCH_DONE':
      return { ...state, phase: 'specifying' };

    case 'SPEC_DONE':
      return { ...state, phase: 'reviewing-spec' };

    case 'APPROVE_SPEC':
      return { ...state, phase: 'planning' };

    case 'REJECT_SPEC':
      return { ...state, phase: 'idle' };

    case 'PLAN_DONE':
      return { ...state, phase: 'reviewing-plan', tasks: action.tasks };

    case 'APPROVE_PLAN':
      return { ...state, phase: 'implementing', currentTaskIndex: 0, attempt: 0 };

    case 'REJECT_PLAN':
      return { ...state, phase: 'idle' };

    case 'BRIEFS_READY':
      return { ...state, phase: 'reviewing-briefs', tasks: action.tasks, currentTaskIndex: 0, attempt: 0 };

    case 'APPROVE_BRIEFS':
      return { ...state, phase: 'implementing', currentTaskIndex: 0, attempt: 0 };

    case 'REJECT_BRIEFS':
      return { ...state, phase: 'idle' };

    case 'SPEC_CLARIFY_START':
      return { ...state, phase: 'clarifying' };

    case 'SPEC_CLARIFY_DONE':
      return { ...state, phase: 'constitution-check' };

    case 'CONSTITUTION_CHECK_PASS':
      return { ...state, phase: 'planning' };

    case 'CONSTITUTION_CHECK_FAIL':
      return { ...state, phase: 'idle', awaitingContinue: false };

    case 'ANALYZE_START':
      return { ...state, phase: 'analyzing' };

    case 'ANALYZE_DONE':
      return { ...state, phase: 'implementing' };

    case 'START_TASK':
      return { ...setTaskStatus(state, action.taskId, 'in_progress'), attempt: 0 };

    case 'TASK_SENT':
      return { ...state, phase: 'validating-task' };

    case 'VALIDATION_PASS':
      return advanceTask(state, 'done');

    case 'VALIDATION_FAIL':
      if (state.attempt < maxRetries) {
        return { ...state, phase: 'implementing', attempt: state.attempt + 1 };
      }
      return { ...state, phase: 'escalating' };

    case 'ESCALATE':
      return { ...state, phase: 'escalating' };

    case 'HINT_SUCCESS':
      return advanceTask(state, 'done');

    case 'HINT_FAIL':
      return { ...state, phase: 'escalating' };

    case 'FULL_SUCCESS':
      return advanceTask(state, 'escalated');

    case 'FULL_FAIL':
      return advanceTask(state, 'failed');

    case 'SKIP_TASK': {
      const withStatus = setTaskStatus(state, action.taskId, 'skipped');
      return {
        ...withStatus,
        currentTaskIndex: state.currentTaskIndex + 1,
      };
    }

    case 'UPDATE_TASK_CODE':
      return {
        ...state,
        tasks: state.tasks.map(t => t.id === action.taskId ? { ...t, currentCode: action.code } : t),
      };

    case 'CLEAR_TASK_CODE':
      return {
        ...state,
        tasks: state.tasks.map(t => {
          if (t.id !== action.taskId) return t;
          const { currentCode: _currentCode, ...task } = t;
          return task;
        }),
      };

    case 'ALL_DONE':
      return { ...state, phase: 'final-review' };

    case 'REVIEW_DONE':
      return { ...state, phase: 'complete' };

    case 'CANCEL':
      return { ...state, phase: 'idle', awaitingContinue: false };

    case 'ABORT_TURN':
      return { ...state, awaitingContinue: true };

    case 'CONTINUE_TURN':
      return { ...state, awaitingContinue: false };

    case 'SET_PLANNER_SESSION_ID':
      return { ...state, plannerSessionId: action.sessionId };

    case 'REWIND_TO_SPEC':
      return {
        ...state,
        phase: 'specifying',
        tasks: [],
        currentTaskIndex: 0,
        attempt: 0,
        awaitingContinue: false,
        rewindPending: { target: 'spec', ...(action.comment ? { comment: action.comment } : {}) },
      };

    case 'REWIND_TO_PLAN':
      return {
        ...state,
        phase: 'planning',
        tasks: [],
        currentTaskIndex: 0,
        attempt: 0,
        awaitingContinue: false,
        rewindPending: { target: 'plan', ...(action.comment ? { comment: action.comment } : {}) },
      };

    case 'CLEAR_REWIND_PENDING':
      return { ...state, rewindPending: undefined };

    case 'RESET_TASK': {
      const idx = state.tasks.findIndex(t => t.id === action.taskId);
      if (idx < 0) return state;
      return {
        ...state,
        tasks: state.tasks.map((t, i) => i === idx ? { ...t, status: 'pending' } : t),
        currentTaskIndex: idx,
        attempt: 0,
        phase: 'implementing',
      };
    }

    case 'ENQUEUE_USER_MSG':
      return { ...state, messageQueue: [...state.messageQueue, action.message] };

    case 'MARK_DELIVERED_NATIVE':
      return {
        ...state,
        messageQueue: state.messageQueue.map(m =>
          m.id === action.id ? { ...m, deliveredViaNative: true } : m
        ),
      };

    case 'DRAIN_QUEUE': {
      const now = new Date().toISOString();
      return {
        ...state,
        messageQueue: state.messageQueue.map(m => m.drainedAt ? m : { ...m, drainedAt: now }),
      };
    }

    case 'CLEAR_QUEUE':
      return { ...state, messageQueue: state.messageQueue.filter(m => m.drainedAt) };

    case 'SET_PENDING_RECOVERY':
      return { ...state, pendingRecovery: action.issue };

    case 'PAUSE_PENDING_RECOVERY':
      if (!state.pendingRecovery) return state;
      return {
        ...state,
        pendingRecovery: {
          ...state.pendingRecovery,
          status: 'paused',
        },
      };

    case 'MARK_RECOVERY_APPLYING':
      return markRecoveryApplying(state, action);

    case 'CLEAR_PENDING_RECOVERY':
      return { ...state, pendingRecovery: undefined };

    case 'RESOLVE_PENDING_RECOVERY':
      return { ...state, pendingRecovery: undefined };

    default:
      return assertNever(action);
  }
}
