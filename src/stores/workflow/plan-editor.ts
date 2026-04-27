import { createStore, storeBase } from '../create-store.js';
import type { Task } from '../../core/schemas/task.js';

export interface PlanEditorState {
  /** Current mutable task list. Empty until the editor is initialized. */
  tasks: Task[];
  /** Zero-based index of the cursor within tasks[]. Clamped to [0, tasks.length - 1]. */
  cursor: number;
  /** Set of task IDs whose full body is expanded (toggled by <enter>). */
  expandedIds: ReadonlySet<string>;
  /**
   * True when the in-memory task list differs from what is on disk.
   * Set to true on any edit operation. Set to false after successful save.
   */
  dirty: boolean;
  /**
   * True when the user pressed `e` from the simple BriefReviewView to opt into
   * the rich editor for this session only. Not persisted to config.
   */
  runtimeRichMode: boolean;
  /**
   * Non-null while an error message from the last save attempt should be shown.
   * Cleared on the next edit operation or on successful save.
   */
  saveError: string | null;
}

const store = createStore<PlanEditorState>(() => ({
  tasks: [],
  cursor: 0,
  expandedIds: new Set<string>(),
  dirty: false,
  runtimeRichMode: false,
  saveError: null,
}));

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<PlanEditorState>): void {
  store.set(
    next
      ? { tasks: [], cursor: 0, expandedIds: new Set<string>(), dirty: false, runtimeRichMode: false, saveError: null, ...next }
      : { tasks: [], cursor: 0, expandedIds: new Set<string>(), dirty: false, runtimeRichMode: false, saveError: null },
  );
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
export const _planEditorInternal = { set: store.set };

function initEditor(tasks: Task[]): void {
  store.set(s => ({
    ...s,
    tasks,
    cursor: 0,
    expandedIds: new Set<string>(),
    dirty: false,
    saveError: null,
  }));
}

function moveCursor(direction: 'up' | 'down'): void {
  store.set(s => {
    if (s.tasks.length === 0) return s;
    const next = direction === 'down'
      ? Math.min(s.cursor + 1, s.tasks.length - 1)
      : Math.max(s.cursor - 1, 0);
    if (next === s.cursor) return s;
    return { ...s, cursor: next };
  });
}

function setTasks(tasks: Task[]): void {
  store.set(s => ({ ...s, tasks, dirty: true }));
}

function toggleExpand(taskId: string): void {
  store.set(s => {
    const next = new Set(s.expandedIds);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    return { ...s, expandedIds: next };
  });
}

function setRuntimeRichMode(value: boolean): void {
  store.set(s => (s.runtimeRichMode === value ? s : { ...s, runtimeRichMode: value }));
}

function setCursor(n: number): void {
  store.set(s => {
    const clamped = s.tasks.length === 0 ? 0 : Math.max(0, Math.min(n, s.tasks.length - 1));
    if (clamped === s.cursor) return s;
    return { ...s, cursor: clamped };
  });
}

function setSaveError(message: string | null): void {
  store.set(s => (s.saveError === message ? s : { ...s, saveError: message }));
}

function markSaved(): void {
  store.set(s => {
    if (!s.dirty && s.saveError === null) return s;
    return { ...s, dirty: false, saveError: null };
  });
}

export const planEditorStore = {
  ...storeBase(store),
  __testReset,
  initEditor,
  moveCursor,
  setCursor,
  setTasks,
  toggleExpand,
  setRuntimeRichMode,
  setSaveError,
  markSaved,
};
