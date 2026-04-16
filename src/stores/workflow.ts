import { createStore, storeBase } from './create-store.js';
import { mergeEvent, updateCounts, updateTaskMap } from './workflow-reducers.js';
import { groupEventsIntoSections } from '../core/event-sections.js';
import { abortStore } from './abort.js';
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
  queueDepth: number;
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
  queueDepth: 0,
};

let cancelHandler: (() => void) | null = null;
let abortHandler: (() => void) | null = null;

type RewindTarget =
  | { target: 'spec'; comment?: string }
  | { target: 'plan'; comment?: string }
  | { target: 'task'; taskId: string };

let rewindHandler: ((request: RewindTarget) => void) | null = null;
let queueHandler: ((text: string, phase: Phase) => void) | null = null;
let clearQueueHandler: (() => number) | null = null;

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
    let { queueDepth } = state;
    if (event.type === 'message-queued') queueDepth++;
    if (event.type === 'queue-drained') queueDepth = 0;
    if (event.type === 'queue-cleared') queueDepth = Math.max(0, queueDepth - event.count);
    return { ...state, events, sections, ...counts, taskMap, tasks, queueDepth };
  });
}

function setCancelHandler(handler: (() => void) | null) {
  cancelHandler = handler;
}

function setAbortHandler(handler: (() => void) | null) {
  abortHandler = handler;
}

function setRewindHandler(handler: ((request: RewindTarget) => void) | null) {
  rewindHandler = handler;
}

function requestRewind(request: RewindTarget): boolean {
  if (!rewindHandler) return false;
  rewindHandler(request);
  return true;
}

function setQueueHandler(handler: ((text: string, phase: Phase) => void) | null) {
  queueHandler = handler;
}

function requestEnqueue(text: string, phase: Phase): boolean {
  if (!queueHandler) return false;
  queueHandler(text, phase);
  return true;
}

function setClearQueueHandler(handler: (() => number) | null) {
  clearQueueHandler = handler;
}

function requestClearQueue(): number {
  if (clearQueueHandler) return clearQueueHandler();
  const depth = store.get().queueDepth;
  if (depth > 0) {
    addEvent({ type: 'queue-cleared', ts: Date.now(), count: depth });
  }
  return depth;
}

function abortTurn(): boolean {
  if (!abortHandler) return false;
  abortHandler();
  return true;
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
    abortHandler = null;
    rewindHandler = null;
    queueHandler = null;
    clearQueueHandler = null;
    abortStore.clear();
    store.reset(init ? { ...initial, ...init } : undefined);
  },
  addEvent,
  setCancelHandler,
  setAbortHandler,
  setRewindHandler,
  abortTurn,
  requestCancel,
  requestRewind,
  setQueueHandler,
  requestEnqueue,
  setClearQueueHandler,
  requestClearQueue,
  toggleSidebar,
};
