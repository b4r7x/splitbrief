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
import { normalizeKeySignature } from '../../../core/keybindings/normalize.js';
import { resolveKeyOwner, type FocusedKeySurface } from '../../../core/keybindings/resolver.js';
import { dropLastCodePoint } from '../../../components/input/text-editing.js';

const mountedStore = createStore<boolean>(false);
const MAX_REGEN_REASON_CHARS = 160;

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
  | { type: 'prompt-regenerate-flagged' }
  | { type: 'submit-regenerate-flagged' }
  | { type: 'update-regenerate-reason'; value: string }
  | { type: 'cancel-regenerate-reason' }
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
  | { type: 'reject' }
  | { type: 'discard' };

function focusSurface(): FocusedKeySurface {
  const focus = planEditorStore.get().focus;
  switch (focus) {
    case 'task-list':
      return 'plan-editor-task-list';
    case 'section-list':
      return 'plan-editor-section-list';
    case 'editing-section':
      return 'plan-editor-editing-section';
    case 'regen-reason':
      return 'plan-editor-regen-reason';
  }
}

function isC0Control(ch: string): boolean {
  const code = ch.codePointAt(0);
  return code !== undefined && (code < 0x20 || code === 0x7f);
}

function stripC0Controls(value: string): string {
  let result = '';
  for (const ch of value) {
    if (!isC0Control(ch)) result += ch;
  }
  return result;
}

function truncateRegenerateReason(value: string): string {
  if (value.length <= MAX_REGEN_REASON_CHARS) return value;
  const truncated = value.slice(0, MAX_REGEN_REASON_CHARS);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? dropLastCodePoint(truncated) : truncated;
}

export function handlePlanEditorInput(input: string, key: Key): PlanEditorAction {
  const state = planEditorStore.get();
  const owner = resolveKeyOwner({
    screen: 'workflow',
    inputMode: 'review',
    focus: focusSurface(),
    overlay: 'none',
    attachState: 'local',
    composerFocus: false,
    key: normalizeKeySignature({ input, key }),
  });
  if (owner?.owner !== 'plan-editor' && owner?.owner !== 'text-editing') {
    return { type: 'none' };
  }

  if (state.focus === 'regen-reason') {
    if (key.escape) return { type: 'cancel-regenerate-reason' };
    if (key.return) return { type: 'submit-regenerate-flagged' };
    if (key.backspace || key.delete) {
      return { type: 'update-regenerate-reason', value: dropLastCodePoint(state.regenReason) };
    }
    if (!key.ctrl && !key.meta && !key.super && !key.hyper && input.length > 0) {
      const text = stripC0Controls(input);
      if (!text) return { type: 'none' };
      return {
        type: 'update-regenerate-reason',
        value: truncateRegenerateReason(`${state.regenReason}${text}`),
      };
    }
    return { type: 'none' };
  }

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
    if (input === 'N') return { type: 'reject' };
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
  if (input === 'R') return { type: 'prompt-regenerate-flagged' };
  if (input === 'p') return { type: 'toggle-packet-preview' };
  if (input === 's') return { type: 'open-editor', mode: 'split' };
  if (input === 'E') return { type: 'open-editor', mode: 'edit' };
  if (input === 'c') return { type: 'copy-selection' };
  if (input === '?') return { type: 'open-help' };
  if (input === 'Y') return { type: 'save' };
  if (input === 'N') return { type: 'reject' };
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
  | { type: 'open-editor' }
  | { type: 'submit-regenerate-flagged' }
  | { type: 'copy-selection' }
  | { type: 'reject' }
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
    case 'prompt-regenerate-flagged':
      planEditorStore.startRegenerateReason();
      return;
    case 'update-regenerate-reason':
      planEditorStore.updateRegenerateReason(action.value);
      return;
    case 'cancel-regenerate-reason':
      planEditorStore.cancelRegenerateReason();
      return;
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
  onRegenerateFlagged?: ((reason?: string | undefined) => Promise<void>) | undefined;
  onReject?: (() => void) | undefined;
}

export function usePlanEditorKeys(options: PlanEditorKeysOptions): void {
  const { onSave, sessionDir, onTogglePacketPreview, onRegenerateFlagged, onReject } = options;
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

  async function submitRegenerateFlagged(): Promise<void> {
    const reason = planEditorStore.get().regenReason.trim();
    if (planEditorStore.get().dirty) {
      await onSave();
      const afterSave = planEditorStore.get();
      if (afterSave.dirty || afterSave.saveError !== null) return;
    }
    planEditorStore.cancelRegenerateReason();
    if (onRegenerateFlagged) await onRegenerateFlagged(reason || undefined);
  }

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
      if (action.type === 'submit-regenerate-flagged') {
        void submitRegenerateFlagged();
        return;
      }
      if (action.type === 'copy-selection') {
        void copyCurrentPlanEditorSelection(sessionDir);
        return;
      }
      if (action.type === 'reject') {
        onReject?.();
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
