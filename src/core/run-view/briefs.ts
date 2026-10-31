import type { EventTypeCarrier } from '../event-phase.js';
import type { SeatChangePoint } from '../crew/seats.js';
import type { FileAction, Phase, RunnerKind, TaskStatus } from '../schemas/enums.js';
import type { CheckResult } from '../schemas/task.js';
import { isImplementerPhase } from '../phases.js';
import { taskStatusForCompletionMethod } from '../task-completion.js';
import type { BriefEvent } from './events.js';

export interface WorkflowTask {
  id: string;
  title: string;
  status: TaskStatus;
  file?: string;
  files?: string[];
  action?: FileAction;
  /** The seat the build started this brief on in the live run; a resume drops it. */
  route?: {
    profile?: string;
    runner?: string;
    model?: string;
    axes?: readonly string[];
    backendKind?: RunnerKind | undefined;
  };
}

/** The run's briefs, where it stands among them, and what each brief last checked. */
export interface RunBriefs {
  readonly tasks: readonly WorkflowTask[];
  readonly taskMap: ReadonlyMap<string, WorkflowTask>;
  /** The position of the brief the run is on, from 1; 0 when it is on none. */
  readonly currentTask: number;
  readonly currentAttempt: number;
  readonly totalTasks: number;
  readonly checks: ReadonlyMap<string, readonly CheckResult[]>;
  /** The run's completed briefs as its last `workflow_complete` counted them, an earlier process's included. */
  readonly completedTasks: number | null;
}

export const EMPTY_BRIEFS: RunBriefs = {
  tasks: [],
  taskMap: new Map(),
  currentTask: 0,
  currentAttempt: 1,
  totalTasks: 0,
  checks: new Map(),
  completedTasks: null,
};

const BRIEF_EVENT_TYPES: Record<BriefEvent['type'], true> = {
  tasks_planned: true,
  task_started: true,
  workflow_resumed: true,
  task_completed: true,
  task_skipped: true,
  task_escalating: true,
  task_full_fail: true,
  task_reset: true,
  task_retry: true,
  implementer_generate_running: true,
  checks_run: true,
  workflow_complete: true,
};

function isBriefEvent<T extends EventTypeCarrier>(event: T): event is T & BriefEvent {
  return Object.hasOwn(BRIEF_EVENT_TYPES, event.type);
}

/** One event folded into the briefs. An event that changes nothing returns the same briefs. */
export function reduceBriefs(briefs: RunBriefs, event: EventTypeCarrier): RunBriefs {
  if (!isBriefEvent(event)) return briefs;
  if (event.type === 'checks_run') {
    return { ...briefs, checks: new Map(briefs.checks).set(event.taskId, event.results) };
  }
  if (event.type === 'workflow_complete') {
    const completedTasks = event.completedTasks ?? null;
    return completedTasks === briefs.completedTasks ? briefs : { ...briefs, completedTasks };
  }
  const taskMap = updateTaskMap(briefs.taskMap, event);
  const tasks = taskMap !== briefs.taskMap ? Array.from(taskMap.values()) : briefs.tasks;
  const counts = updateTaskCounts(briefs, event, tasks);
  if (
    taskMap === briefs.taskMap &&
    tasks === briefs.tasks &&
    counts.currentTask === briefs.currentTask &&
    counts.currentAttempt === briefs.currentAttempt &&
    counts.totalTasks === briefs.totalTasks
  ) {
    return briefs;
  }
  return { ...briefs, ...counts, taskMap, tasks };
}

function updateTaskMap(
  taskMap: ReadonlyMap<string, WorkflowTask>,
  event: BriefEvent,
): ReadonlyMap<string, WorkflowTask> {
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
        ...(existing?.files !== undefined && { files: existing.files }),
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
          ...(event.axes !== undefined && { axes: event.axes }),
          ...(event.backendKind !== undefined && { backendKind: event.backendKind }),
        },
      }),
    });
    return next;
  }
  // A resumed run reads its seats again, so a brief it starts again runs on the saved seat.
  if (event.type === 'workflow_resumed') {
    if (![...taskMap.values()].some((task) => task.route !== undefined)) return taskMap;
    const next = new Map<string, WorkflowTask>();
    for (const [id, { route: _route, ...task }] of taskMap) next.set(id, task);
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

function updateTaskCounts(
  briefs: RunBriefs,
  event: BriefEvent,
  tasks: readonly WorkflowTask[],
): Pick<RunBriefs, 'currentTask' | 'currentAttempt' | 'totalTasks'> {
  let { currentAttempt, totalTasks } = briefs;
  const focusedId =
    event.type === 'task_started' || event.type === 'task_reset'
      ? event.taskId
      : briefs.tasks[briefs.currentTask - 1]?.id;
  const currentTask = tasks.findIndex((task) => task.id === focusedId) + 1;
  if (event.type === 'tasks_planned') {
    totalTasks = event.total;
  }
  if (event.type === 'task_started') {
    currentAttempt = event.lineageAttempt ?? 1;
    totalTasks = event.total;
  }
  // `attempt` counts the retries already spent, so the attempt now running is one past it.
  if (event.type === 'task_retry') {
    currentAttempt = event.lineageAttempt ?? event.attempt + 1;
  }
  if (event.type === 'implementer_generate_running') {
    currentAttempt = event.lineageAttempt ?? currentAttempt;
  }
  return { currentTask, currentAttempt, totalTasks };
}

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
export function selectTaskListView(briefs: Pick<RunBriefs, 'tasks' | 'totalTasks'>): TaskListView {
  const total = Math.max(briefs.totalTasks, briefs.tasks.length);
  // A brief that escalated did not pass its checks on the seat that was given it, so it is counted
  // apart from the ones that did: the fraction on screen never flatters the run. It did finish
  // though, on a higher rung, so `finished` is what a caller asks when it needs the work left.
  let passed = 0;
  let escalated = 0;
  let failed = 0;
  for (const task of briefs.tasks) {
    if (task.status === 'done') passed += 1;
    else if (task.status === 'escalated') escalated += 1;
    else if (task.status === 'failed') failed += 1;
  }
  return {
    items: briefs.tasks,
    passed,
    escalated,
    failed,
    finished: passed + escalated,
    total,
    unannounced: Math.max(0, total - briefs.tasks.length),
  };
}

export interface RunningBrief {
  current: WorkflowTask | null;
  next: WorkflowTask | null;
}

type BriefFocus = Pick<RunBriefs, 'tasks' | 'currentTask'>;

// The brief a stop would interrupt and the one it would not start. One derivation, so the stop
// sheet, the byline and the park can never name a different pair. The run's own position names the
// brief, not its status: continuing a halt resets the brief to pending before the build starts it
// again, and the run is on it all the same. A brief that already finished is no brief a stop would
// interrupt, and outside the build a pending brief is only one the plan lists.
export function selectRunningBrief(briefs: BriefFocus, phase: Phase): RunningBrief {
  const index = briefs.currentTask - 1;
  const current = briefs.tasks[index];
  const onIt =
    current?.status === 'in_progress' ||
    (current?.status === 'pending' && isImplementerPhase(phase));
  if (current === undefined || !onIt) return { current: null, next: null };
  return { current, next: briefs.tasks[index + 1] ?? null };
}

/** The brief the run last finished and has not yet handed on from. */
export function selectFinishedBrief(briefs: BriefFocus): WorkflowTask | null {
  const focused = briefs.tasks[briefs.currentTask - 1];
  return focused !== undefined && (focused.status === 'done' || focused.status === 'escalated')
    ? focused
    : null;
}

/**
 * Where a seat saved now takes over: after the brief that runs or just finished, else after the
 * next brief. The final review has no brief left, so only a fix brief or the next run takes it.
 */
export function selectSeatChangePoint(briefs: BriefFocus, phase: Phase): SeatChangePoint {
  if (phase === 'final-review') return { after: 'fix-brief-or-next-run' };
  const brief = selectRunningBrief(briefs, phase).current ?? selectFinishedBrief(briefs);
  return brief === null ? { after: 'next-brief' } : { after: 'brief', taskId: brief.id };
}

/** The brief that follows a named one, which is what a boundary pause is holding back. */
export function briefAfter(briefs: Pick<RunBriefs, 'tasks'>, taskId: string): WorkflowTask | null {
  const index = briefs.tasks.findIndex((task) => task.id === taskId);
  return index === -1 ? null : (briefs.tasks[index + 1] ?? null);
}
