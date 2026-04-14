import type { WorkflowState, StateAction, TaskStatus, TokenUsage, TaskId } from '../types/index.js';

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

export function transition(state: WorkflowState, action: StateAction, maxRetries: number = 3): WorkflowState {
  switch (action.type) {
    case 'START':
      return { ...state, phase: 'researching' };

    case 'START_QUICK':
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

    default:
      action satisfies never;
      return state;
  }
}
