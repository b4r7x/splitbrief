import { createStore, storeBase } from './create-store.js';
import { killAllProcesses } from '../utils/process.js';
import type { Phase, SidebarTask, TuiEvent, TokenUsage } from '../types.js';

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
  tokenUsage: TokenUsage | null;
  cancelled: boolean;
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
  tokenUsage: null,
  cancelled: false,
};

let abortController: AbortController | null = null;

const store = createStore<WorkflowState>(initial);

export function mergeEvent(events: TuiEvent[], event: TuiEvent): TuiEvent[] {
  const last = events[events.length - 1];
  let next: TuiEvent[];
  if (event.type === 'planner-text' && last?.type === 'planner-text') {
    next = [...events.slice(0, -1), { ...last, text: last.text + event.text }];
  } else if (event.type === 'validate' && event.status === 'running' && last?.type === 'validate' && last.status === 'running') {
    next = [...events.slice(0, -1), event];
  } else {
    next = [...events, event];
  }
  return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
}

export function updateCounts(state: WorkflowState, event: TuiEvent): Pick<WorkflowState, 'phase' | 'currentTask' | 'totalTasks' | 'localCount' | 'escalatedCount'> {
  let { phase, currentTask, totalTasks, localCount, escalatedCount } = state;
  if (event.type === 'planner-status') phase = event.phase as Phase;
  if (event.type === 'task-start') {
    currentTask = event.index + 1;
    totalTasks = event.total;
  }
  if (event.type === 'task-complete') {
    if (event.method === 'local') localCount += 1;
    else if (event.method === 'escalated-hint' || event.method === 'escalated-full') escalatedCount += 1;
  }
  return { phase, currentTask, totalTasks, localCount, escalatedCount };
}

export function updateTaskMap(taskMap: Map<string, SidebarTask>, event: TuiEvent): Map<string, SidebarTask> {
  if (event.type === 'task-start') {
    const next = new Map(taskMap);
    next.set(event.taskId, { id: event.taskId, title: event.title, status: 'in_progress' });
    return next;
  }
  if (event.type === 'task-complete' || event.type === 'task-skipped') {
    const status = event.type === 'task-complete' ? 'done' : 'skipped';
    const existing = taskMap.get(event.taskId);
    if (existing) {
      const next = new Map(taskMap);
      next.set(event.taskId, { ...existing, status });
      return next;
    }
  }
  return taskMap;
}

function addEvent(event: TuiEvent) {
  store.set(state => {
    if (state.cancelled) return state;
    if (event.type === 'cost-update') {
      return { ...state, tokenUsage: event.tokenUsage };
    }
    const events = mergeEvent(state.events, event);
    const counts = updateCounts(state, event);
    const taskMap = updateTaskMap(state.taskMap, event);
    return { ...state, events, ...counts, taskMap };
  });
}

function setReviewFile(path: string | null) {
  store.set(s => s.reviewFilePath === path ? s : { ...s, reviewFilePath: path });
}

function setAbortController(controller: AbortController | null) {
  if (abortController && controller !== abortController) abortController.abort();
  abortController = controller;
}

function requestCancel() {
  const state = store.get();
  if (state.cancelled) return;
  if (abortController) abortController.abort();
  const now = Date.now();
  store.set(s => {
    const events = s.events.map(ev =>
      ev.type === 'planner-status' && ev.status === 'running'
        ? { ...ev, status: 'done' as const }
        : ev,
    );
    const final = [...events, { type: 'workflow-cancelled' as const, ts: now }];
    return { ...s, cancelled: true, events: final };
  });
  try { killAllProcesses(); } catch { /* process cleanup is best-effort */ }
}

export const workflowStore = {
  ...storeBase(store),
  reset: (init?: Partial<WorkflowState>) => {
    abortController = null;
    store.reset(init ? { ...initial, ...init } : undefined);
  },
  addEvent,
  setReviewFile,
  setAbortController,
  requestCancel,
};
