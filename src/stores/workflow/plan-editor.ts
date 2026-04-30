import { createStore, storeBase } from '../create-store.js';
import type { Task } from '../../core/schemas/task.js';
import type { ImplementerCostTier } from '../../core/schemas/implementer-config.js';

export type PlanReviewRisk = 'low' | 'medium' | 'high';
export type PlanReviewContextFit = 'fits' | 'tight' | 'overflow';
export type PlanReviewCostTier = ImplementerCostTier;
export type PlanReviewEstimateStatus =
  | 'refreshed-current-code'
  | 'brief-current-code'
  | 'missing-current-code'
  | 'current-code-unavailable';

export interface PlanReviewConflictMetadata {
  kind: string;
  files: string[];
  affectedTaskIds?: string[] | undefined;
  note?: string | undefined;
}

export interface PlanTaskReviewMetadata {
  taskId: string;
  workerProfile?: string | undefined;
  selectedCostTier?: PlanReviewCostTier | undefined;
  costPosture?: string | undefined;
  contextFit?: PlanReviewContextFit | undefined;
  estimatedTokens?: number | undefined;
  contextLength?: number | undefined;
  estimateStatus?: PlanReviewEstimateStatus | undefined;
  routingReason?: string | undefined;
  validationStatus?: 'pending' | 'pass' | 'warn' | 'fail' | undefined;
  risk?: PlanReviewRisk | undefined;
  stale?: boolean | undefined;
  conflict?: PlanReviewConflictMetadata | undefined;
  checkpoint?: string | undefined;
}

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
  /**
   * Optional review-time execution metadata keyed by task ID. Routing decisions
   * are produced elsewhere; the editor only renders whatever metadata is known.
   */
  reviewMetadata: ReadonlyMap<string, PlanTaskReviewMetadata>;
}

const store = createStore<PlanEditorState>(() => ({
  tasks: [],
  cursor: 0,
  expandedIds: new Set<string>(),
  dirty: false,
  runtimeRichMode: false,
  saveError: null,
  reviewMetadata: new Map<string, PlanTaskReviewMetadata>(),
}));

function cloneTasks(tasks: Task[]): Task[] {
  return structuredClone(tasks);
}

function cloneReviewMetadata(metadata: PlanTaskReviewMetadata): PlanTaskReviewMetadata {
  return structuredClone(metadata);
}

function cloneReviewMetadataMap(
  metadata: ReadonlyMap<string, PlanTaskReviewMetadata>,
): Map<string, PlanTaskReviewMetadata> {
  return new Map(Array.from(metadata, ([taskId, value]) => [taskId, cloneReviewMetadata(value)]));
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<PlanEditorState>): void {
  const base = { tasks: [], cursor: 0, expandedIds: new Set<string>(), dirty: false, runtimeRichMode: false, saveError: null, reviewMetadata: new Map<string, PlanTaskReviewMetadata>() };
  if (!next) {
    store.set(base);
    return;
  }
  store.set({
    ...base,
    ...next,
    tasks: next.tasks ? cloneTasks(next.tasks) : base.tasks,
    expandedIds: next.expandedIds ? new Set(next.expandedIds) : base.expandedIds,
    reviewMetadata: next.reviewMetadata ? cloneReviewMetadataMap(next.reviewMetadata) : base.reviewMetadata,
  });
}

function initEditor(tasks: Task[]): void {
  const nextTasks = cloneTasks(tasks);
  store.set(s => ({
    ...s,
    tasks: nextTasks,
    cursor: 0,
    expandedIds: new Set<string>(),
    dirty: false,
    saveError: null,
    reviewMetadata: sameTasks(s.tasks, nextTasks) ? s.reviewMetadata : new Map<string, PlanTaskReviewMetadata>(),
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

function sameTasks(a: Task[], b: Task[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function setTasks(tasks: Task[]): void {
  const nextTasks = cloneTasks(tasks);
  store.set(s => {
    if (sameTasks(s.tasks, nextTasks)) return s;
    return {
      ...s,
      tasks: nextTasks,
      dirty: true,
      saveError: null,
      reviewMetadata: new Map<string, PlanTaskReviewMetadata>(),
    };
  });
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

function setReviewMetadata(metadata: PlanTaskReviewMetadata[]): void {
  store.set(s => {
    const next = new Map<string, PlanTaskReviewMetadata>();
    for (const item of metadata) {
      next.set(item.taskId, cloneReviewMetadata(item));
    }
    if (sameReviewMetadata(s.reviewMetadata, next)) return s;
    return { ...s, reviewMetadata: next };
  });
}

function upsertTaskReviewMetadata(metadata: PlanTaskReviewMetadata): void {
  store.set(s => {
    const current = s.reviewMetadata.get(metadata.taskId);
    const merged = cloneReviewMetadata(mergeReviewMetadata(current, metadata));
    if (current && JSON.stringify(current) === JSON.stringify(merged)) return s;
    const next = new Map(s.reviewMetadata);
    next.set(metadata.taskId, merged);
    return { ...s, reviewMetadata: next };
  });
}

function mergeReviewMetadata(
  current: PlanTaskReviewMetadata | undefined,
  patch: PlanTaskReviewMetadata,
): PlanTaskReviewMetadata {
  return current ? { ...current, ...patch, taskId: patch.taskId } : patch;
}

function sameReviewMetadata(
  a: ReadonlyMap<string, PlanTaskReviewMetadata>,
  b: ReadonlyMap<string, PlanTaskReviewMetadata>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [taskId, value] of a) {
    const other = b.get(taskId);
    if (!other || JSON.stringify(value) !== JSON.stringify(other)) return false;
  }
  return true;
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
  setReviewMetadata,
  upsertTaskReviewMetadata,
  markSaved,
};
