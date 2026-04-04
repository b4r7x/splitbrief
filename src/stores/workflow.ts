import { createStore, storeBase } from './create-store.js';
import type { Phase, TuiEvent, SidebarTask } from '../types.js';

export const MAX_EVENTS = 10_000;

export interface WorkflowState {
  events: TuiEvent[];
  phase: Phase;
  currentTask: number;
  totalTasks: number;
  localCount: number;
  escalatedCount: number;
  reviewFilePath: string | null;
  taskMap: Map<string, SidebarTask>;
}

const initial: WorkflowState = {
  events: [],
  phase: 'idle',
  currentTask: 0,
  totalTasks: 0,
  localCount: 0,
  escalatedCount: 0,
  reviewFilePath: null,
  taskMap: new Map(),
};

const store = createStore<WorkflowState>(initial);

function addEvent(event: TuiEvent) {
  store.set(state => {
    const next = [...state.events, event];
    const events = next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
    let { phase, currentTask, totalTasks, localCount, escalatedCount } = state;

    if (event.type === 'planner-status') phase = event.phase as Phase;
    if (event.type === 'task-start') {
      currentTask = event.index + 1;
      totalTasks = event.total;
    }
    if (event.type === 'task-complete') {
      if (event.method === 'local') localCount += 1;
      else escalatedCount += 1;
    }

    let taskMap = state.taskMap;
    if (event.type === 'task-start') {
      taskMap = new Map(taskMap);
      taskMap.set(event.taskId, { id: event.taskId, title: event.title, status: 'in_progress' });
    } else if (event.type === 'task-complete' || event.type === 'task-skipped') {
      const status = event.type === 'task-complete' ? 'done' : 'skipped';
      const existing = taskMap.get(event.taskId);
      if (existing) {
        taskMap = new Map(taskMap);
        taskMap.set(event.taskId, { ...existing, status });
      }
    }

    return { ...state, events, phase, currentTask, totalTasks, localCount, escalatedCount, taskMap };
  });
}

function setReviewFile(path: string | null) {
  store.set(s => ({ ...s, reviewFilePath: path }));
}

export const workflowStore = {
  ...storeBase(store),
  reset: (init?: Partial<WorkflowState>) => store.reset(init ? { ...initial, ...init } : undefined),
  addEvent,
  setReviewFile,
};
