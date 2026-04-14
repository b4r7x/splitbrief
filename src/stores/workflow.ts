import { createStore, storeBase } from './create-store.js';
import { mergeEvent, updateCounts, updateTaskMap } from './workflow-reducers.js';
import { groupEventsIntoSections } from '../core/event-sections.js';
import type { Section } from '../core/event-sections.js';
import type { Phase, SidebarTask, TuiEvent, TokenUsage } from '../types.js';

export interface WorkflowViewState {
  events: TuiEvent[];
  sections: Section[];
  phase: Phase;
  currentTask: number;
  totalTasks: number;
  localCount: number;
  escalatedCount: number;
  taskCompletionTimes: number[];
  taskMap: Map<string, SidebarTask>;
  tasks: SidebarTask[];
  tokenUsage: TokenUsage | null;
  cancelled: boolean;
  sidebarVisible: boolean;
}

const initial: WorkflowViewState = {
  events: [],
  sections: [],
  phase: 'idle',
  currentTask: 0,
  totalTasks: 0,
  localCount: 0,
  escalatedCount: 0,
  taskCompletionTimes: [],
  taskMap: new Map(),
  tasks: [],
  tokenUsage: null,
  cancelled: false,
  sidebarVisible: false,
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
    const tasks = taskMap !== state.taskMap ? Array.from(taskMap.values()) : state.tasks;
    const sections = events !== state.events ? groupEventsIntoSections(events) : state.sections;
    return { ...state, events, sections, ...counts, taskMap, tasks };
  });
}

function setCancelHandler(handler: (() => void) | null) {
  cancelHandler = handler;
}

function requestCancel(): boolean {
  let shouldCallHandler = false;
  const now = Date.now();
  store.set(s => {
    if (s.cancelled) return s;
    shouldCallHandler = true;
    const events = s.events.map(ev =>
      ev.type === 'planner-status' && ev.status === 'running'
        ? { ...ev, status: 'done' as const }
        : ev,
    );
    const final = [...events, { type: 'workflow-cancelled' as const, ts: now }];
    return { ...s, cancelled: true, events: final, sections: groupEventsIntoSections(final) };
  });
  if (!shouldCallHandler) return false;
  if (cancelHandler) cancelHandler();
  return true;
}

function toggleSidebar() {
  store.set(s => ({ ...s, sidebarVisible: !s.sidebarVisible }));
}

export const workflowStore = {
  ...storeBase(store),
  reset: (init?: Partial<WorkflowViewState>) => {
    cancelHandler = null;
    store.reset(init ? { ...initial, ...init } : undefined);
  },
  addEvent,
  setCancelHandler,
  requestCancel,
  toggleSidebar,
};
