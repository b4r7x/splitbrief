import * as ink from 'ink';
import { normalizeKeySignature } from '../../core/keybindings/normalize.js';
import { resolveEditorKeyAction } from '../../core/keybindings/editor.js';
import { selectionRange } from '../../core/editor/editor-state.js';
import type { EditorEvent, EditorSurface } from '../../core/editor/editor-state.js';
import { editorStore } from '../../stores/ui/editor.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { approvalPromptStore } from '../../stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../../stores/cost-approval/prompt.js';
import { copyToClipboard } from '../../lib/clipboard/clipboard.js';
import { useFieldSessionOwned } from './use-field-session-owned.js';

interface UseEditorKeysOptions {
  surface: EditorSurface;
  onSave?: (() => void) | undefined;
  onCancel?: (() => void) | undefined;
  onOpenExternal?: (() => void) | undefined;
  onFieldNext?: (() => void) | undefined;
  onFieldPrev?: (() => void) | undefined;
}

function isDestructive(event: EditorEvent): boolean {
  return event.kind === 'insert' || event.kind === 'delete';
}

export function useEditorKeys({
  surface,
  onSave,
  onCancel,
  onOpenExternal,
  onFieldNext,
  onFieldPrev,
}: UseEditorKeysOptions): void {
  const surfaceOpen = editorStore.use((s) => s.status === 'open' && s.surface === surface);
  const overlayReady = overlayStore.use((s) => s.exclusive && s.active === 'editor');
  const fieldOwned = useFieldSessionOwned();
  // The inline field editor is not itself an overlay, so it must stand down whenever an overlay
  // or approval/cost prompt covers it — otherwise its useInput and the overlay's both fire for
  // every keystroke (two owners for one event, CON-D / REQ-049) and typing into the overlay also
  // mutates the hidden brief buffer. This mirrors the composer's disabled=(hasOverlay||promptPending).
  const overlayBlocking = overlayStore.use((s) => s.active !== 'none');
  const promptPending = approvalPromptStore.use((s) => s.status === 'pending');
  const costPending = costApprovalStore.use((s) => s.status === 'pending');
  const fieldActive = fieldOwned && !overlayBlocking && !promptPending && !costPending;
  const isActive = surfaceOpen && (surface === 'raw' ? overlayReady : fieldActive);

  ink.useInput(
    (input, key) => {
      const state = editorStore.get();
      if (state.status !== 'open') return;

      if (key.tab) {
        if (key.shift) onFieldPrev?.();
        else onFieldNext?.();
        return;
      }

      // Bracketed paste and multi-grapheme input arrive as one string: insert them as a single
      // paste edit so an embedded newline never triggers the newline/save binding (REQ-050) and
      // the whole block is one undo unit (REQ-053). Escapes/C0/CRLF are already stripped upstream
      // by createFilteredStdin before the bytes reach the input hook (REQ-051/052).
      if (input.length > 1 && !key.ctrl && !key.meta) {
        if (state.submitting) return;
        editorStore.dispatch({ kind: 'insert', text: input, paste: true });
        return;
      }

      const action = resolveEditorKeyAction(normalizeKeySignature({ input, key }));
      if (action === null) return;

      switch (action.kind) {
        case 'save':
          onSave?.();
          return;
        case 'cancel':
          onCancel?.();
          return;
        case 'open-external':
          onOpenExternal?.();
          return;
        case 'copy': {
          const range = selectionRange(state);
          if (range) void copyToClipboard(state.value.slice(range.start, range.end));
          return;
        }
        case 'cut': {
          if (state.submitting) return;
          const range = selectionRange(state);
          if (range) {
            void copyToClipboard(state.value.slice(range.start, range.end));
            editorStore.dispatch({ kind: 'delete', dir: 'backward', unit: 'char' });
          }
          return;
        }
        default:
          if (state.submitting && isDestructive(action)) return;
          editorStore.dispatch(action);
      }
    },
    { isActive },
  );
}
