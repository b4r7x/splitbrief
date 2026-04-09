import { createStore, storeBase } from './create-store.js';
import { killAllProcesses } from '../utils/process.js';
import { mergeEvent, updateCounts, updateTaskMap } from './workflow-reducers.js';
import type { Phase, SidebarTask, TuiEvent, TokenUsage } from '../types.js';

export interface WorkflowViewState {
  events: TuiEvent[];
  phase: Phase;
  currentTask: number;
  totalTasks: number;
  localCount: number;
  escalatedCount: number;
  reviewFilePath: string | null;
  reviewScrollOffset: number;
  reviewLineCount: number;
  taskMap: Map<string, SidebarTask>;
  tokenUsage: TokenUsage | null;
  cancelled: boolean;
  sidebarVisible: boolean;
  inputInteractive: boolean;
}

const initial: WorkflowViewState = {
  events: [],
  phase: 'idle',
  currentTask: 0,
  totalTasks: 0,
  localCount: 0,
  escalatedCount: 0,
  reviewFilePath: null,
  reviewScrollOffset: 0,
  reviewLineCount: 0,
  taskMap: new Map(),
  tokenUsage: null,
  cancelled: false,
  sidebarVisible: false,
  inputInteractive: false,
};

let cancelHandler: (() => void) | null = null;

const store = createStore<WorkflowViewState>(initial);

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
  store.set(s => s.reviewFilePath === path ? s : { ...s, reviewFilePath: path, reviewScrollOffset: 0, reviewLineCount: 0 });
}

function setReviewScroll(offset: number) {
  store.set(s => s.reviewScrollOffset === offset ? s : { ...s, reviewScrollOffset: offset });
}

function setReviewLineCount(count: number) {
  store.set(s => s.reviewLineCount === count ? s : { ...s, reviewLineCount: count });
}

function setCancelHandler(handler: (() => void) | null) {
  cancelHandler = handler;
}

function requestCancel() {
  const state = store.get();
  if (state.cancelled) return;
  if (cancelHandler) cancelHandler();
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

function toggleSidebar() {
  store.set(s => ({ ...s, sidebarVisible: !s.sidebarVisible }));
}

function setInputInteractive(active: boolean) {
  store.set(s => s.inputInteractive === active ? s : { ...s, inputInteractive: active });
}

export const workflowStore = {
  ...storeBase(store),
  reset: (init?: Partial<WorkflowViewState>) => {
    cancelHandler = null;
    store.reset(init ? { ...initial, ...init } : undefined);
  },
  addEvent,
  setReviewFile,
  setReviewScroll,
  setReviewLineCount,
  setCancelHandler,
  requestCancel,
  toggleSidebar,
  setInputInteractive,
};
