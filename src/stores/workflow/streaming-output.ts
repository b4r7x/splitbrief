import { createStore, storeBase } from '../create-store.js';
import type { TaskId } from '../../core/schemas/task.js';

export interface StreamingOutputState {
  taskId: TaskId | null;
  lines: string[];
  active: boolean;
}

const initial: StreamingOutputState = {
  taskId: null,
  lines: [],
  active: false,
};

const store = createStore<StreamingOutputState>(initial);

function __testReset(next?: Partial<StreamingOutputState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

function startStreaming(taskId: TaskId): void {
  store.set({ taskId, lines: [], active: true });
}

function pushLines(lines: string[]): void {
  store.set(s => {
    if (!s.active) return s;
    return { ...s, lines };
  });
}

function stopStreaming(): void {
  store.set(s => {
    if (!s.active) return s;
    return { ...s, active: false };
  });
}

function reset(): void {
  store.set(initial);
}

export const streamingOutputStore = {
  ...storeBase(store),
  __testReset,
  startStreaming,
  pushLines,
  stopStreaming,
  reset,
};