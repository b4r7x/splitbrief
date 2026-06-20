import { useEffect } from 'react';
import { useInput, type Key } from 'ink';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import { createStore, storeBase } from '../../../stores/create-store.js';
import { deleteTask, mergeWithPrevious, moveTaskDown, moveTaskUp } from '../plan-editor/actions.js';
import { openExternalEditor } from '../plan-editor/external-editor.js';
import { copyPlanEditorSelection } from '../plan-editor/copy.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { Task } from '../../../core/schemas/task.js';
import { TASK_BRIEF_SECTIONS } from '../../../stores/workflow/plan-editor-sections.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

const mountedStore = createStore<boolean>(false);

// True only while the rich plan editor's key layer is mounted. The global shortcut
// layer reads this to release Ctrl+K (its command-palette binding) back to the editor's
// reorder chord, so a single press never both reorders a task and opens the palette.
export const planEditorKeysStore = {
  ...storeBase(mountedStore),
  __testReset: () => mountedStore.set(false),
};

export type PlanEditorAction =
  | { type: 'none' }
  | { type: 'move-cursor'; direction: 'up' | 'down' }
  | { type: 'move-task'; direction: 'up' | 'down' }
  | { type: 'delete-task' }
  | { type: 'merge-task' }
  | { type: 'toggle-expand' }
  | { type: 'toggle-flag' }
  | { type: 'regenerate-flagged' }
  | { type: 'toggle-packet-preview' }
  | { type: 'open-help' }
  | { type: 'open-editor'; mode: 'edit' | 'split' }
  | { type: 'enter-section-list' }
  | { type: 'leave-section-list' }
  | { type: 'move-section-cursor'; direction: 'up' | 'down' }
  | { type: 'start-section-edit' }
  | { type: 'save-section-edit' }
  | { type: 'cancel-section-edit' }
  | { type: 'copy-selection' }
  | { type: 'save' }
  | { type: 'discard' };

export function handlePlanEditorInput(input: string, key: Key): PlanEditorAction {
  const state = planEditorStore.get();
  if (state.focus === 'editing-section') {
    if (key.escape) return { type: 'cancel-section-edit' };
    if (key.ctrl && key.return) return { type: 'save-section-edit' };
    return { type: 'none' };
  }

  if (state.focus === 'section-list') {
    if (key.escape) return { type: 'leave-section-list' };
    if (key.downArrow || input === 'j') return { type: 'move-section-cursor', direction: 'down' };
    if (key.upArrow || input === 'k') return { type: 'move-section-cursor', direction: 'up' };
    if (input === 'e') return { type: 'start-section-edit' };
    if (input === 'c') return { type: 'copy-selection' };
    if (input === 'Y') return { type: 'save' };
    if (input === 'q') return { type: 'discard' };
    if (input === '?') return { type: 'open-help' };
    return { type: 'none' };
  }

  if (key.ctrl) {
    if (input === 'j' || input === 'n') return { type: 'move-task', direction: 'down' };
    if (input === 'k' || input === 'p') return { type: 'move-task', direction: 'up' };
    return { type: 'none' };
  }
  if (key.downArrow) return { type: 'move-cursor', direction: 'down' };
  if (key.upArrow) return { type: 'move-cursor', direction: 'up' };
  if (key.return) return { type: 'toggle-expand' };
  if (key.tab) return { type: 'enter-section-list' };
  if (input === 'j') return { type: 'move-cursor', direction: 'down' };
  if (input === 'k') return { type: 'move-cursor', direction: 'up' };
  if (input === 'd') return { type: 'delete-task' };
  if (input === 'm') return { type: 'merge-task' };
  if (input === 'x') return { type: 'toggle-flag' };
  if (input === 'R') return { type: 'regenerate-flagged' };
  if (input === 'p') return { type: 'toggle-packet-preview' };
  if (input === 's') return { type: 'open-editor', mode: 'split' };
  if (input === 'E') return { type: 'open-editor', mode: 'edit' };
  if (input === 'c') return { type: 'copy-selection' };
  if (input === '?') return { type: 'open-help' };
  if (input === 'Y') return { type: 'save' };
  if (input === 'q') return { type: 'discard' };
  return { type: 'none' };
}

function applyTaskResult(
  beforeTasks: Task[],
  beforeCursor: number,
  result: { tasks: Task[]; cursor: number },
): void {
  if (result.tasks === beforeTasks && result.cursor === beforeCursor) return;
  planEditorStore.setTasks(result.tasks);
  planEditorStore.setCursor(result.cursor);
}

type StoreEditorAction = Exclude<
  PlanEditorAction,
  { type: 'open-editor' } | { type: 'regenerate-flagged' } | { type: 'copy-selection' }
>;

export function applyPlanEditorAction(
  action: StoreEditorAction,
  onSave: () => Promise<void>,
  onTogglePacketPreview?: (() => void) | undefined,
): void {
  switch (action.type) {
    case 'none':
      return;
    case 'move-cursor':
      planEditorStore.moveCursor(action.direction);
      return;
    case 'move-task': {
      const { tasks, cursor } = planEditorStore.get();
      const result =
        action.direction === 'down' ? moveTaskDown(tasks, cursor) : moveTaskUp(tasks, cursor);
      applyTaskResult(tasks, cursor, result);
      return;
    }
    case 'delete-task': {
      const { tasks, cursor } = planEditorStore.get();
      const result = deleteTask(tasks, cursor);
      applyTaskResult(tasks, cursor, result);
      return;
    }
    case 'merge-task': {
      const { tasks, cursor } = planEditorStore.get();
      const result = mergeWithPrevious(tasks, cursor);
      if (result.error) {
        planEditorStore.setSaveError(result.error);
        return;
      }
      applyTaskResult(tasks, cursor, result);
      return;
    }
    case 'toggle-expand': {
      const { tasks, cursor } = planEditorStore.get();
      const task = tasks[cursor];
      if (task) planEditorStore.toggleExpand(task.id);
      return;
    }
    case 'enter-section-list':
      planEditorStore.enterSectionList();
      return;
    case 'leave-section-list':
      planEditorStore.leaveSectionList();
      return;
    case 'move-section-cursor':
      planEditorStore.moveSectionCursor(action.direction);
      return;
    case 'start-section-edit':
      planEditorStore.startEditingSection();
      return;
    case 'save-section-edit':
      planEditorStore.saveEditingSection();
      return;
    case 'cancel-section-edit':
      planEditorStore.cancelEditingSection();
      return;
    case 'toggle-flag': {
      const { tasks, cursor } = planEditorStore.get();
      const task = tasks[cursor];
      if (task) planEditorStore.toggleFlag(task.id);
      return;
    }
    case 'toggle-packet-preview':
      onTogglePacketPreview?.();
      return;
    case 'open-help':
      overlayStore.open('plan-editor-help');
      return;
    case 'save':
      void onSave();
      return;
    case 'discard': {
      planEditorStore.discardEdits();
      return;
    }
    default:
      assertNever(action);
  }
}

export interface PlanEditorKeysOptions {
  onSave: () => Promise<void>;
  sessionDir: string;
  onTogglePacketPreview?: (() => void) | undefined;
  onRegenerateFlagged?: (() => Promise<void>) | undefined;
}

export function usePlanEditorKeys(options: PlanEditorKeysOptions): void {
  const { onSave, sessionDir, onTogglePacketPreview, onRegenerateFlagged } = options;
  const isOverlayOpen = overlayStore.use((s) => s.active !== 'none');

  useEffect(() => {
    mountedStore.set(true);
    return () => mountedStore.set(false);
  }, []);

  useInput(
    (_input, _key) => {
      overlayStore.close();
    },
    { isActive: overlayStore.use((s) => s.active === 'plan-editor-help') },
  );

  useInput(
    (input, key) => {
      const action = handlePlanEditorInput(input, key);
      if (action.type === 'open-editor') {
        const { tasks, cursor } = planEditorStore.get();
        const task = tasks[cursor];
        if (!task) return;
        openExternalEditor({ task, mode: action.mode, sessionDirPath: sessionDir });
        return;
      }
      if (action.type === 'regenerate-flagged') {
        if (onRegenerateFlagged) void onRegenerateFlagged();
        return;
      }
      if (action.type === 'copy-selection') {
        void copyCurrentPlanEditorSelection(sessionDir);
        return;
      }
      applyPlanEditorAction(action, onSave, onTogglePacketPreview);
    },
    { isActive: !isOverlayOpen },
  );
}

export async function copyCurrentPlanEditorSelection(sessionDir: string): Promise<void> {
  const { tasks, cursor, focus, sectionCursor } = planEditorStore.get();
  const task = tasks[cursor];
  if (!task) return;
  const section = focus === 'section-list' ? TASK_BRIEF_SECTIONS[sectionCursor] : undefined;
  try {
    const result = await copyPlanEditorSelection({
      sessionDirPath: sessionDir,
      task,
      ...(section !== undefined && { section }),
    });
    planEditorStore.setStatusMessage(result.message);
  } catch (err) {
    planEditorStore.setSaveError(`Failed to copy: ${toErrorMessage(err)}`);
  }
}
