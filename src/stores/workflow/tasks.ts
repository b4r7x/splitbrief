import { createStore, storeBase } from '../create-store.js';
import type { SidebarTask, TuiEvent } from '../../types.js';

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

export const tasksStore = {
  ...storeBase(store),
  set: store.set,
};

export function updateTaskMap(
  taskMap: Map<string, SidebarTask>,
  event: TuiEvent,
): Map<string, SidebarTask> {
  if (event.type === 'task-start') {
    const next = new Map(taskMap);
    next.set(event.taskId, { id: event.taskId, title: event.title, status: 'in_progress' });
    return next;
  }
  if (event.type === 'task-complete' || event.type === 'task-skipped') {
    const status = event.type === 'task-complete' ? 'done' : 'skipped';
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
  event: TuiEvent,
): Pick<TasksState, 'currentTask' | 'totalTasks' | 'taskCompletionTimes'> {
  let { currentTask, totalTasks, taskCompletionTimes } = state;
  if (event.type === 'task-start') {
    currentTask = event.index + 1;
    totalTasks = event.total;
  }
  if (event.type === 'task-complete') {
    taskCompletionTimes = [...taskCompletionTimes, event.duration];
  }
  return { currentTask, totalTasks, taskCompletionTimes };
}
