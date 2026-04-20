import { createStore, storeBase } from '../create-store.js';
import type { EngineEvent } from '../../engine/events/types.js';
import type { SidebarTask } from '../../features/workflow/components/sidebar.js';

export interface TasksState {
  currentTask: number;
  totalTasks: number;
  taskCompletionTimes: number[];
  taskMap: Map<string, SidebarTask>;
  tasks: SidebarTask[];
}

const initial: TasksState = {
  currentTask: 0,
  totalTasks: 0,
  taskCompletionTimes: [],
  taskMap: new Map(),
  tasks: [],
};

const store = createStore<TasksState>(initial);

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<TasksState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
// Production use is limited to workflow/actions.ts (the dispatcher).
export const _tasksInternal = { set: store.set };

export const tasksStore = {
  ...storeBase(store),
  __testReset,
};

export function updateTaskMap(
  taskMap: Map<string, SidebarTask>,
  event: EngineEvent,
): Map<string, SidebarTask> {
  if (event.type === 'task_started') {
    const next = new Map(taskMap);
    next.set(event.taskId, { id: event.taskId, title: event.title, status: 'in_progress' });
    return next;
  }
  if (event.type === 'task_completed' || event.type === 'task_skipped') {
    const status = event.type === 'task_completed' ? 'done' : 'skipped';
    const existing = taskMap.get(event.taskId);
    if (!existing || existing.status === status) return taskMap;
    const next = new Map(taskMap);
    next.set(event.taskId, { ...existing, status });
    return next;
  }
  return taskMap;
}

export function updateTaskCounts(
  state: TasksState,
  event: EngineEvent,
): Pick<TasksState, 'currentTask' | 'totalTasks' | 'taskCompletionTimes'> {
  let { currentTask, totalTasks, taskCompletionTimes } = state;
  if (event.type === 'task_started') {
    currentTask = event.index + 1;
    totalTasks = event.total;
  }
  if (event.type === 'task_completed') {
    taskCompletionTimes = [...taskCompletionTimes, event.duration];
  }
  return { currentTask, totalTasks, taskCompletionTimes };
}
