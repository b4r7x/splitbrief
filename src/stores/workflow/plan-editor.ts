import { createStore, storeBase } from '../create-store.js';
import type { Task } from '../../core/schemas/task.js';
import type { PlanTaskReviewMetadata } from '../../core/plan-review/types.js';
import { deepEqual } from '../../utils/deep-equal.js';
import { clampIndex } from '../../utils/indexing.js';
import {
  TASK_BRIEF_SECTIONS,
  getTaskBriefSectionLabel,
  getTaskBriefSectionText,
  updateTaskBriefSection,
  type TaskBriefSection,
} from './plan-editor-sections.js';

export type PlanEditorFocus = 'task-list' | 'section-list' | 'editing-section' | 'regen-reason';

export interface PlanEditorSectionEdit {
  taskId: string;
  section: TaskBriefSection;
  value: string;
}

export interface PlanEditorState {
  tasks: Task[];
  savedTasks: Task[];
  cursor: number;
  revision: number;
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
  flaggedIds: ReadonlySet<string>;
  focus: PlanEditorFocus;
  sectionCursor: number;
  editing: PlanEditorSectionEdit | null;
  regenReason: string;
  statusMessage: string | null;
}

export const PLAN_EDITOR_STALE_SAVE_ERROR =
  'Plan changed during save. Save again to persist the latest edits.';

function makeInitialState(): PlanEditorState {
  return {
    tasks: [],
    savedTasks: [],
    cursor: 0,
    revision: 0,
    expandedIds: new Set<string>(),
    dirty: false,
    runtimeRichMode: false,
    saveError: null,
    reviewMetadata: new Map<string, PlanTaskReviewMetadata>(),
    flaggedIds: new Set<string>(),
    focus: 'task-list',
    sectionCursor: 0,
    editing: null,
    regenReason: '',
    statusMessage: null,
  };
}

const store = createStore<PlanEditorState>(makeInitialState);

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

function __testReset(next?: Partial<PlanEditorState>): void {
  const base = makeInitialState();
  if (!next) {
    store.set(base);
    return;
  }
  store.set({
    ...base,
    ...next,
    tasks: next.tasks ? cloneTasks(next.tasks) : base.tasks,
    savedTasks: next.savedTasks
      ? cloneTasks(next.savedTasks)
      : next.tasks
        ? cloneTasks(next.tasks)
        : base.savedTasks,
    expandedIds: next.expandedIds ? new Set(next.expandedIds) : base.expandedIds,
    reviewMetadata: next.reviewMetadata
      ? cloneReviewMetadataMap(next.reviewMetadata)
      : base.reviewMetadata,
    flaggedIds: next.flaggedIds ? new Set(next.flaggedIds) : base.flaggedIds,
    editing: next.editing ? { ...next.editing } : base.editing,
    regenReason: next.regenReason ?? base.regenReason,
  });
}

function initEditor(tasks: Task[]): void {
  const nextTasks = cloneTasks(tasks);
  const nextSavedTasks = cloneTasks(tasks);
  store.set((s) => ({
    ...s,
    tasks: nextTasks,
    savedTasks: nextSavedTasks,
    cursor: 0,
    revision: sameTasks(s.tasks, nextTasks) && !s.dirty ? s.revision : s.revision + 1,
    expandedIds: new Set<string>(),
    focus: 'task-list',
    sectionCursor: 0,
    editing: null,
    regenReason: '',
    statusMessage: null,
    dirty: false,
    saveError: null,
    reviewMetadata: sameTasks(s.tasks, nextTasks)
      ? s.reviewMetadata
      : new Map<string, PlanTaskReviewMetadata>(),
    flaggedIds: sameTasks(s.tasks, nextTasks) ? s.flaggedIds : new Set<string>(),
  }));
}

function moveCursor(direction: 'up' | 'down'): void {
  store.set((s) => {
    if (s.tasks.length === 0) return s;
    const next =
      direction === 'down' ? Math.min(s.cursor + 1, s.tasks.length - 1) : Math.max(s.cursor - 1, 0);
    if (next === s.cursor) return s;
    return { ...s, cursor: next, sectionCursor: 0 };
  });
}

function sameTasks(a: Task[], b: Task[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((t, i) => deepEqual(t, b[i]));
}

function taskMapById(tasks: Task[]): Map<string, Task> {
  return new Map(tasks.map((task) => [task.id, task]));
}

function stableTaskIds(
  currentTasks: Task[],
  nextTasks: Task[],
  taskIds: ReadonlySet<string>,
): Set<string> {
  if (taskIds.size === 0) return new Set<string>();
  const currentById = taskMapById(currentTasks);
  const nextById = taskMapById(nextTasks);
  const stable = new Set<string>();
  for (const id of taskIds) {
    const current = currentById.get(id);
    const next = nextById.get(id);
    if (current && next && deepEqual(current, next)) stable.add(id);
  }
  return stable;
}

function setTasks(tasks: Task[]): void {
  const nextTasks = cloneTasks(tasks);
  store.set((s) => {
    if (sameTasks(s.tasks, nextTasks)) return s;
    return {
      ...s,
      tasks: nextTasks,
      revision: s.revision + 1,
      dirty: true,
      saveError: null,
      statusMessage: null,
      focus: s.editing ? 'editing-section' : s.focus === 'regen-reason' ? 'task-list' : s.focus,
      expandedIds: stableTaskIds(s.tasks, nextTasks, s.expandedIds),
      reviewMetadata: new Map<string, PlanTaskReviewMetadata>(),
      flaggedIds: stableTaskIds(s.tasks, nextTasks, s.flaggedIds),
      regenReason: '',
    };
  });
}

function toggleExpand(taskId: string): void {
  store.set((s) => {
    const next = new Set(s.expandedIds);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    return { ...s, expandedIds: next };
  });
}

function enterSectionList(): void {
  store.set((s) => {
    const task = s.tasks[s.cursor];
    if (!task) return s;
    const nextExpanded = new Set(s.expandedIds);
    nextExpanded.add(task.id);
    return {
      ...s,
      expandedIds: nextExpanded,
      focus: 'section-list',
      sectionCursor: clampIndex(s.sectionCursor, TASK_BRIEF_SECTIONS.length),
      editing: null,
    };
  });
}

function leaveSectionList(): void {
  store.set((s) =>
    s.focus === 'task-list' ? s : { ...s, focus: 'task-list', sectionCursor: 0, editing: null },
  );
}

function moveSectionCursor(direction: 'up' | 'down'): void {
  store.set((s) => {
    if (s.focus !== 'section-list') return s;
    const next =
      direction === 'down'
        ? Math.min(s.sectionCursor + 1, TASK_BRIEF_SECTIONS.length - 1)
        : Math.max(s.sectionCursor - 1, 0);
    if (next === s.sectionCursor) return s;
    return { ...s, sectionCursor: next };
  });
}

function startEditingSection(): void {
  store.set((s) => {
    const task = s.tasks[s.cursor];
    const section = TASK_BRIEF_SECTIONS[s.sectionCursor];
    if (!task || !section) return s;
    return {
      ...s,
      focus: 'editing-section',
      editing: {
        taskId: task.id,
        section,
        value: getTaskBriefSectionText(task, section),
      },
      saveError: null,
      statusMessage: null,
    };
  });
}

function updateEditingValue(value: string): void {
  store.set((s) => {
    if (!s.editing) return s;
    return { ...s, editing: { ...s.editing, value } };
  });
}

function saveEditingSection(): void {
  const state = store.get();
  const edit = state.editing;
  if (!edit) return;
  const nextTasks = state.tasks.map((task) =>
    task.id === edit.taskId ? updateTaskBriefSection(task, edit.section, edit.value) : task,
  );
  setTasks(nextTasks);
  store.set((s) => ({
    ...s,
    focus: 'section-list',
    expandedIds: new Set([...s.expandedIds, edit.taskId]),
    editing: null,
    statusMessage: `updated ${getTaskBriefSectionLabel(edit.section)}`,
  }));
}

function cancelEditingSection(): void {
  store.set((s) =>
    s.editing ? { ...s, focus: 'section-list', editing: null, statusMessage: null } : s,
  );
}

function setRuntimeRichMode(value: boolean): void {
  store.set((s) => (s.runtimeRichMode === value ? s : { ...s, runtimeRichMode: value }));
}

function setCursor(n: number): void {
  store.set((s) => {
    const clamped = clampIndex(n, s.tasks.length);
    if (clamped === s.cursor) return s;
    return { ...s, cursor: clamped };
  });
}

function setSaveError(message: string | null): void {
  store.set((s) => {
    const nextStatusMessage = message === null ? s.statusMessage : null;
    if (s.saveError === message && s.statusMessage === nextStatusMessage) return s;
    return { ...s, saveError: message, statusMessage: nextStatusMessage };
  });
}

function setStatusMessage(message: string | null): void {
  store.set((s) => {
    const nextSaveError = message === null ? s.saveError : null;
    if (s.statusMessage === message && s.saveError === nextSaveError) return s;
    return { ...s, statusMessage: message, saveError: nextSaveError };
  });
}

function toggleFlag(taskId: string): void {
  store.set((s) => {
    const next = new Set(s.flaggedIds);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
    }
    return { ...s, flaggedIds: next };
  });
}

function clearFlags(): void {
  store.set((s) => {
    if (s.flaggedIds.size === 0) return s;
    return { ...s, flaggedIds: new Set<string>() };
  });
}

function startRegenerateReason(): void {
  store.set((s) => {
    if (s.flaggedIds.size === 0) return s;
    return {
      ...s,
      focus: 'regen-reason',
      editing: null,
      regenReason: '',
      saveError: null,
      statusMessage: 'reason optional; press Enter to regenerate flagged tasks',
    };
  });
}

function updateRegenerateReason(value: string): void {
  store.set((s) => (s.focus === 'regen-reason' ? { ...s, regenReason: value } : s));
}

function cancelRegenerateReason(): void {
  store.set((s) =>
    s.focus === 'regen-reason'
      ? { ...s, focus: 'task-list', regenReason: '', statusMessage: null }
      : s,
  );
}

function getFlaggedTasks(): Task[] {
  const { tasks, flaggedIds } = store.get();
  return tasks.filter((t) => flaggedIds.has(t.id));
}

function setReviewMetadata(metadata: PlanTaskReviewMetadata[]): void {
  store.set((s) => {
    const next = new Map<string, PlanTaskReviewMetadata>();
    for (const item of metadata) {
      next.set(item.taskId, cloneReviewMetadata(item));
    }
    if (sameReviewMetadata(s.reviewMetadata, next)) return s;
    return { ...s, reviewMetadata: next };
  });
}

function upsertTaskReviewMetadata(metadata: PlanTaskReviewMetadata): void {
  store.set((s) => {
    const current = s.reviewMetadata.get(metadata.taskId);
    const merged = cloneReviewMetadata(mergeReviewMetadata(current, metadata));
    if (current && deepEqual(current, merged)) return s;
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
    if (!other || !deepEqual(value, other)) return false;
  }
  return true;
}

function markSaved(): void {
  store.set((s) => {
    if (!s.dirty && s.saveError === null && sameTasks(s.savedTasks, s.tasks)) return s;
    return { ...s, savedTasks: cloneTasks(s.tasks), dirty: false, saveError: null };
  });
}

function markSavedIfRevision(revision: number): boolean {
  let saved = false;
  store.set((s) => {
    if (s.revision !== revision) {
      return s.saveError === PLAN_EDITOR_STALE_SAVE_ERROR
        ? s
        : { ...s, saveError: PLAN_EDITOR_STALE_SAVE_ERROR, statusMessage: null };
    }
    saved = true;
    if (!s.dirty && s.saveError === null && sameTasks(s.savedTasks, s.tasks)) return s;
    return { ...s, savedTasks: cloneTasks(s.tasks), dirty: false, saveError: null };
  });
  return saved;
}

function discardEdits(): void {
  store.set((s) => {
    const nextTasks = cloneTasks(s.savedTasks);
    const changed = !sameTasks(s.tasks, nextTasks) || s.dirty;
    return {
      ...s,
      tasks: nextTasks,
      cursor: clampIndex(s.cursor, nextTasks.length),
      revision: changed ? s.revision + 1 : s.revision,
      expandedIds: new Set<string>(),
      dirty: false,
      runtimeRichMode: false,
      saveError: null,
      statusMessage: null,
      focus: 'task-list',
      sectionCursor: 0,
      editing: null,
      regenReason: '',
      reviewMetadata: new Map<string, PlanTaskReviewMetadata>(),
      flaggedIds: new Set<string>(),
    };
  });
}

function resetSessionState(): void {
  store.set(makeInitialState());
}

function setLoadFailure(message: string): void {
  store.set((s) => ({
    ...s,
    tasks: [],
    savedTasks: [],
    cursor: 0,
    revision:
      s.tasks.length > 0 || s.savedTasks.length > 0 || s.dirty ? s.revision + 1 : s.revision,
    expandedIds: new Set<string>(),
    dirty: false,
    saveError: message,
    reviewMetadata: new Map<string, PlanTaskReviewMetadata>(),
    flaggedIds: new Set<string>(),
    focus: 'task-list',
    sectionCursor: 0,
    editing: null,
    regenReason: '',
    statusMessage: null,
  }));
}

export const planEditorStore = {
  ...storeBase(store),
  __testReset,
  resetSessionState,
  initEditor,
  moveCursor,
  setCursor,
  setTasks,
  toggleExpand,
  enterSectionList,
  leaveSectionList,
  moveSectionCursor,
  startEditingSection,
  updateEditingValue,
  saveEditingSection,
  cancelEditingSection,
  toggleFlag,
  clearFlags,
  startRegenerateReason,
  updateRegenerateReason,
  cancelRegenerateReason,
  getFlaggedTasks,
  setRuntimeRichMode,
  setSaveError,
  setLoadFailure,
  setStatusMessage,
  setReviewMetadata,
  upsertTaskReviewMetadata,
  markSaved,
  markSavedIfRevision,
  discardEdits,
};
