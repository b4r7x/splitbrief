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
  files?: string[];
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
  const anchor = task.action === undefined ? task.file : `${task.file} (${task.action})`;
  // A slice writes more than one file, and the row has room for one. The anchor is the file the
  // brief is named after; the rest are counted, in their own ` · ` token with the unit spelled, so
  // the count cannot be read as part of the path it follows.
  const extra = (task.files?.length ?? 1) - 1;
  if (extra === 0) return anchor;
  return `${anchor} · +${extra} ${extra === 1 ? 'file' : 'files'}`;
}

export interface TasksState {
  currentTask: number;
  currentAttempt: number;
  totalTasks: number;
  taskCompletionTimes: number[];
  taskMap: Map<string, WorkflowTask>;
  tasks: WorkflowTask[];
}

const initial: TasksState = {
  currentTask: 0,
  currentAttempt: 1,
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
  passed: number;
  escalated: number;
  failed: number;
  /** Briefs that will not run again: the ones that passed plus the ones a higher rung finished. */
  finished: number;
  total: number;
  unannounced: number;
}

// `tasks_planned` seeds the whole plan, so `unannounced` is normally zero. It stays non-zero only
// for a stream that never carried the announcement, where `totalTasks` comes from `task_started`
// and the tail has no titles to list.
export function selectTaskListView(state: TasksState): TaskListView {
  const total = Math.max(state.totalTasks, state.tasks.length);
  // A brief that escalated did not pass its checks on the seat that was given it, so it is counted
  // apart from the ones that did: the fraction on screen never flatters the run. It did finish
  // though, on a higher rung, so `finished` is what a caller asks when it needs the work left.
  let passed = 0;
  let escalated = 0;
  let failed = 0;
  for (const task of state.tasks) {
    if (task.status === 'done') passed += 1;
    else if (task.status === 'escalated') escalated += 1;
    else if (task.status === 'failed') failed += 1;
  }
  return {
    items: state.tasks,
    passed,
    escalated,
    failed,
    finished: passed + escalated,
    total,
    unannounced: Math.max(0, total - state.tasks.length),
  };
}

export interface RunningBrief {
  current: WorkflowTask | null;
  next: WorkflowTask | null;
}

// The brief a stop would interrupt and the one it would not start. One derivation, so the stop
// sheet, the byline and the park can never name a different pair.
export function selectRunningBrief(state: TasksState): RunningBrief {
  const index = state.tasks.findIndex((task) => task.status === 'in_progress');
  if (index === -1) return { current: null, next: null };
  return { current: state.tasks[index] ?? null, next: state.tasks[index + 1] ?? null };
}

/** The brief that follows a named one, which is what a boundary pause is holding back. */
export function briefAfter(state: TasksState, taskId: string): WorkflowTask | null {
  const index = state.tasks.findIndex((task) => task.id === taskId);
  return index === -1 ? null : (state.tasks[index + 1] ?? null);
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
      ...(event.files === undefined ? {} : { files: [...event.files] }),
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
  // The final review reopened these briefs: until their fix attempts pass, none of them has.
  if (event.type === 'review_fix_started') {
    const next = new Map(taskMap);
    for (const id of event.taskIds) {
      const existing = next.get(id);
      if (existing !== undefined) next.set(id, { ...existing, status: 'pending' });
    }
    return next;
  }
  return taskMap;
}

export function updateTaskCounts(
  state: TasksState,
  event: EngineEvent,
): Pick<TasksState, 'currentTask' | 'currentAttempt' | 'totalTasks' | 'taskCompletionTimes'> {
  let { currentTask, currentAttempt, totalTasks, taskCompletionTimes } = state;
  if (event.type === 'tasks_planned') {
    totalTasks = event.total;
  }
  if (event.type === 'task_started') {
    currentTask = event.index + 1;
    currentAttempt = 1;
    totalTasks = event.total;
  }
  // `attempt` counts the retries already spent, so the attempt now running is one past it.
  if (event.type === 'task_retry') {
    currentAttempt = event.attempt + 1;
  }
  if (event.type === 'task_completed') {
    taskCompletionTimes = [...taskCompletionTimes, event.duration];
  }
  return { currentTask, currentAttempt, totalTasks, taskCompletionTimes };
}
