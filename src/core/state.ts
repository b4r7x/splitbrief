import type { WorkflowState, StateAction, TokenUsage } from './types.js';

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
    stateVersion: 2,
    phase: 'idle',
    feature,
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    completedTasks: [],
    escalatedTasks: [],
    skippedTasks: [],
    failedTasks: [],
    sessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: { ...zeroTokenUsage },
  };
}

function advanceTask(state: WorkflowState, list: 'completedTasks' | 'escalatedTasks' | 'failedTasks'): WorkflowState {
  const taskId = state.tasks[state.currentTaskIndex]?.id;
  return {
    ...state,
    phase: 'implementing',
    currentTaskIndex: state.currentTaskIndex + 1,
    attempt: 0,
    [list]: taskId ? [...state[list], taskId] : state[list],
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

    case 'TASK_SENT':
      return { ...state, phase: 'validating-task' };

    case 'VALIDATION_PASS':
      return advanceTask(state, 'completedTasks');

    case 'VALIDATION_FAIL':
      if (state.attempt < maxRetries) {
        return { ...state, phase: 'implementing', attempt: state.attempt + 1 };
      }
      return { ...state, phase: 'escalating' };

    case 'ESCALATE':
      return { ...state, phase: 'escalating' };

    case 'HINT_SUCCESS':
      return advanceTask(state, 'completedTasks');

    case 'HINT_FAIL':
      return { ...state, phase: 'escalating' };

    case 'FULL_SUCCESS':
      return advanceTask(state, 'escalatedTasks');

    case 'FULL_FAIL':
      return advanceTask(state, 'failedTasks');

    case 'ALL_DONE':
      return { ...state, phase: 'final-review' };

    case 'REVIEW_DONE':
      return { ...state, phase: 'complete' };

    case 'CANCEL':
      return { ...state, phase: 'idle' };

    case 'SET_SESSION_ID':
      return { ...state, sessionId: action.sessionId };

    default: {
      const _exhaustive: never = action;
      return state;
    }
  }
}
