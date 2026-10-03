import * as ink from 'ink';
import { normalizeKeySignature } from '../../core/keybindings/normalize.js';
import { resolveEditorKeyAction } from '../../core/keybindings/editor.js';
import { selectionRange } from '../../core/editor/editor-state.js';
import type { EditorEvent } from '../../core/editor/editor-state.js';
import { editorStore } from '../../stores/ui/editor.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { copyToClipboard } from '../../lib/clipboard/clipboard.js';

interface UseEditorKeysOptions {
  onSave: () => void;
  onCancel: () => void;
  onOpenExternal: () => void;
}

function isDestructive(event: EditorEvent): boolean {
  return event.kind === 'insert' || event.kind === 'delete';
}

export function useEditorKeys({ onSave, onCancel, onOpenExternal }: UseEditorKeysOptions): void {
  const surfaceOpen = editorStore.use((s) => s.status === 'open');
  const overlayReady = overlayStore.use((s) => s.exclusive && s.active === 'editor');
  const isActive = surfaceOpen && overlayReady;

  ink.useInput(
    (input, key) => {
      const state = editorStore.get();
      if (state.status !== 'open') return;
      if (key.tab) return;

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
          onSave();
          return;
        case 'cancel':
          onCancel();
          return;
        case 'open-external':
          onOpenExternal();
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
