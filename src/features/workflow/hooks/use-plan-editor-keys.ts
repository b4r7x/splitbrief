import { useInput, type Key } from 'ink';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { planEditorStore } from '../../../stores/workflow/plan-editor.js';
import {
  deleteTask,
  mergeWithPrevious,
  moveTaskDown,
  moveTaskUp,
} from '../components/plan-editor/actions.js';
import { openExternalEditor } from '../components/plan-editor/external-editor.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { Task } from '../../../core/schemas/task.js';

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
  | { type: 'save' }
  | { type: 'discard' };

export function handlePlanEditorInput(input: string, key: Key): PlanEditorAction {
  if (key.ctrl) {
    if (input === 'j' || input === 'n') return { type: 'move-task', direction: 'down' };
    if (input === 'k' || input === 'p') return { type: 'move-task', direction: 'up' };
    return { type: 'none' };
  }
  if (key.downArrow) return { type: 'move-cursor', direction: 'down' };
  if (key.upArrow) return { type: 'move-cursor', direction: 'up' };
  if (key.return) return { type: 'toggle-expand' };
  if (input === 'j') return { type: 'move-cursor', direction: 'down' };
  if (input === 'k') return { type: 'move-cursor', direction: 'up' };
  if (input === 'd') return { type: 'delete-task' };
  if (input === 'm') return { type: 'merge-task' };
  if (input === 'x') return { type: 'toggle-flag' };
  if (input === 'R') return { type: 'regenerate-flagged' };
  if (input === 'p') return { type: 'toggle-packet-preview' };
  if (input === 's') return { type: 'open-editor', mode: 'split' };
  if (input === 'e') return { type: 'open-editor', mode: 'edit' };
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

export function applyPlanEditorAction(
  action: PlanEditorAction,
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
    case 'toggle-flag': {
      const { tasks, cursor } = planEditorStore.get();
      const task = tasks[cursor];
      if (task) planEditorStore.toggleFlag(task.id);
      return;
    }
    case 'regenerate-flagged': {
      return;
    }
    case 'toggle-packet-preview':
      onTogglePacketPreview?.();
      return;
    case 'open-help':
      overlayStore.open('plan-editor-help');
      return;
    case 'open-editor':
      return;
    case 'save':
      void onSave();
      return;
    case 'discard': {
      planEditorStore.reset();
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
        openExternalEditor(task, action.mode, sessionDir);
        return;
      }
      if (action.type === 'regenerate-flagged') {
        if (onRegenerateFlagged) void onRegenerateFlagged();
        return;
      }
      applyPlanEditorAction(action, onSave, onTogglePacketPreview);
    },
    { isActive: !isOverlayOpen },
  );
}
