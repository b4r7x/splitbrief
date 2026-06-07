import { createStore, storeBase } from '../create-store.js';
import type { EngineEvent } from '../../engine/events/types.js';
import type { TaskCompletionMethod, TaskStatus } from '../../core/schemas/enums.js';
import { assertNever } from '../../utils/type-guards.js';

export interface WorkflowTask {
  id: string;
  title: string;
  status: TaskStatus;
}

export interface TasksState {
  currentTask: number;
  totalTasks: number;
  taskCompletionTimes: number[];
  taskMap: Map<string, WorkflowTask>;
  tasks: WorkflowTask[];
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

function statusFromCompletionMethod(method: TaskCompletionMethod): TaskStatus {
  switch (method) {
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    case 'escalated-full':
    case 'escalated-hint':
    case 'escalated-intermediate':
      return 'escalated';
    case 'local':
    case 'mcp-tool':
      return 'done';
    default:
      return assertNever(method);
  }
}

export function updateTaskMap(
  taskMap: Map<string, WorkflowTask>,
  event: EngineEvent,
): Map<string, WorkflowTask> {
  if (event.type === 'task_started') {
    const next = new Map(taskMap);
    next.set(event.taskId, { id: event.taskId, title: event.title, status: 'in_progress' });
    return next;
  }
  if (event.type === 'task_completed' || event.type === 'task_skipped') {
    const status =
      event.type === 'task_completed' ? statusFromCompletionMethod(event.method) : 'skipped';
    const existing = taskMap.get(event.taskId);
    if (!existing || existing.status === status) return taskMap;
    const next = new Map(taskMap);
    next.set(event.taskId, { ...existing, status });
    return next;
  }
  if (event.type === 'task_escalating') {
    const existing = taskMap.get(event.taskId);
    if (!existing || existing.status === 'in_progress') return taskMap;
    const next = new Map(taskMap);
    next.set(event.taskId, { ...existing, status: 'in_progress' });
    return next;
  }
  if (event.type === 'task_full_fail') {
    const existing = taskMap.get(event.taskId);
    if (!existing || existing.status === 'failed') return taskMap;
    const next = new Map(taskMap);
    next.set(event.taskId, { ...existing, status: 'failed' });
    return next;
  }
  if (event.type === 'task_reset') {
    const existing = taskMap.get(event.taskId);
    if (!existing || existing.status === 'pending') return taskMap;
    const next = new Map(taskMap);
    next.set(event.taskId, { ...existing, status: 'pending' });
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
