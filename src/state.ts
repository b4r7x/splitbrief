import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowState, StateAction, Task, TokenUsage, Event } from './types.js';

const MAX_RETRIES = 3;

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

export function transition(state: WorkflowState, action: StateAction): WorkflowState {
  switch (action.type) {
    case 'START':
      return { ...state, phase: 'researching' };

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

    case 'VALIDATION_PASS': {
      const taskId = state.tasks[state.currentTaskIndex]?.id;
      return {
        ...state,
        phase: 'implementing',
        currentTaskIndex: state.currentTaskIndex + 1,
        attempt: 0,
        completedTasks: taskId ? [...state.completedTasks, taskId] : state.completedTasks,
      };
    }

    case 'VALIDATION_FAIL':
      if (state.attempt < MAX_RETRIES) {
        return { ...state, phase: 'implementing', attempt: state.attempt + 1 };
      }
      return state;

    case 'ESCALATE':
      return { ...state, phase: 'escalating' };

    case 'HINT_SUCCESS': {
      const taskId = state.tasks[state.currentTaskIndex]?.id;
      return {
        ...state,
        phase: 'implementing',
        currentTaskIndex: state.currentTaskIndex + 1,
        completedTasks: taskId ? [...state.completedTasks, taskId] : state.completedTasks,
      };
    }

    case 'HINT_FAIL':
      return { ...state, phase: 'escalating' };

    case 'FULL_SUCCESS': {
      const taskId = state.tasks[state.currentTaskIndex]?.id;
      return {
        ...state,
        phase: 'implementing',
        currentTaskIndex: state.currentTaskIndex + 1,
        escalatedTasks: taskId ? [...state.escalatedTasks, taskId] : state.escalatedTasks,
      };
    }

    case 'FULL_FAIL': {
      const taskId = state.tasks[state.currentTaskIndex]?.id;
      return {
        ...state,
        phase: 'implementing',
        currentTaskIndex: state.currentTaskIndex + 1,
        failedTasks: taskId ? [...state.failedTasks, taskId] : state.failedTasks,
      };
    }

    case 'ALL_DONE':
      return { ...state, phase: 'final-review' };

    case 'REVIEW_DONE':
      return { ...state, phase: 'complete' };

    case 'CANCEL':
      return { ...state, phase: 'idle' };

    case 'SET_SESSION_ID':
      return { ...state, sessionId: action.sessionId };

    default:
      return state;
  }
}

function stateDir(projectDir: string): string {
  return join(projectDir, '.tiny-spec', 'current');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function saveState(projectDir: string, state: WorkflowState): void {
  const dir = stateDir(projectDir);
  ensureDir(dir);
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
}

export function loadState(projectDir: string): WorkflowState | null {
  const filePath = join(stateDir(projectDir), 'state.json');
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8')) as WorkflowState;
}

export function appendEvent(projectDir: string, event: Event): void {
  const dir = stateDir(projectDir);
  ensureDir(dir);
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(event) + '\n');
}
