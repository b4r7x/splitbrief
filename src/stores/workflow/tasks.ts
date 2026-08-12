import { createStore, storeBase } from '../create-store.js';
import type { EngineEvent, EngineEventOf } from '../../engine/events/types.js';
import type { TaskStatus } from '../../core/schemas/enums.js';
import { taskStatusForCompletionMethod } from '../../core/task-completion.js';

type FileAction = EngineEventOf<'task_started'>['action'];

export interface WorkflowTask {
  id: string;
  title: string;
  status: TaskStatus;
  file?: string;
  action?: FileAction;
  route?: {
    profile?: string;
    runner?: string;
    model?: string;
  };
}

// Both `tasks_planned` and `task_started` carry `file` and `action`, but the resume path rebuilds
// tasks from persisted state that has neither, so a row cannot assume they are there. Rendering the
// pair through this is what stops a missing field reaching the screen as the literal `undefined`.
export function taskTargetLabel(task: WorkflowTask): string {
  if (task.file === undefined || task.file === '') return '';
  return task.action === undefined ? task.file : `${task.file} (${task.action})`;
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
// Production use is limited to workflow/actions/ (the dispatcher).
export const _tasksInternal = { set: store.set };

export const tasksStore = {
  ...storeBase(store),
  __testReset,
};

export interface TaskListView {
  items: readonly WorkflowTask[];
  settled: number;
  total: number;
  unannounced: number;
}

// `tasks_planned` seeds the whole plan, so `unannounced` is normally zero. It stays non-zero only
// for a stream that never carried the announcement, where `totalTasks` comes from `task_started`
// and the tail has no titles to list.
export function selectTaskListView(state: TasksState): TaskListView {
  const total = Math.max(state.totalTasks, state.tasks.length);
  let settled = 0;
  for (const task of state.tasks) {
    if (task.status === 'done' || task.status === 'escalated') settled += 1;
  }
  return {
    items: state.tasks,
    settled,
    total,
    unannounced: Math.max(0, total - state.tasks.length),
  };
}

export function updateTaskMap(
  taskMap: Map<string, WorkflowTask>,
  event: EngineEvent,
): Map<string, WorkflowTask> {
  if (event.type === 'tasks_planned') {
    const next = new Map<string, WorkflowTask>();
    for (const task of event.tasks) {
      const existing = taskMap.get(task.id);
      next.set(task.id, {
        id: task.id,
        title: task.title,
        status: existing?.status ?? 'pending',
        file: task.file,
        action: task.action,
        ...(existing?.route !== undefined && { route: existing.route }),
      });
    }
    return next;
  }
  if (event.type === 'task_started') {
    const next = new Map(taskMap);
    const hasRoute =
      event.implementerProfile !== undefined ||
      event.tool !== undefined ||
      event.model !== undefined;
    next.set(event.taskId, {
      id: event.taskId,
      title: event.title,
      status: 'in_progress',
      file: event.file,
      action: event.action,
      ...(hasRoute && {
        route: {
          ...(event.implementerProfile !== undefined && { profile: event.implementerProfile }),
          ...(event.tool !== undefined && { runner: event.tool }),
          ...(event.model !== undefined && { model: event.model }),
        },
      }),
    });
    return next;
  }
  if (event.type === 'task_completed' || event.type === 'task_skipped') {
    const status =
      event.type === 'task_completed' ? taskStatusForCompletionMethod(event.method) : 'skipped';
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
  if (event.type === 'tasks_planned') {
    totalTasks = event.total;
  }
  if (event.type === 'task_started') {
    currentTask = event.index + 1;
    totalTasks = event.total;
  }
  if (event.type === 'task_completed') {
    taskCompletionTimes = [...taskCompletionTimes, event.duration];
  }
  return { currentTask, totalTasks, taskCompletionTimes };
}
