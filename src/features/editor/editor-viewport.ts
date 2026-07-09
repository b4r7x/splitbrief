import { clampScrollToDocument } from '../../core/editor/editor-state.js';
import {
  type EditorAffinity,
  type VisualLine,
  visualPositionOf,
} from '../../core/editor/grapheme-motions.js';

export function caretVisualPosition(
  lines: VisualLine[],
  cursor: number,
  affinity: EditorAffinity = 'upstream',
): { row: number; col: number } {
  return visualPositionOf(lines, cursor, affinity);
}

// The render honors the store's scrollTop (set by keyboard caret-follow in the reducer OR by the
// mouse wheel via editorStore.scrollBy) and clamps only to document bounds, never back to the
// caret. Re-clamping to the caret here would revert every wheel nudge that moves the caret out of
// view, defeating REQ-030 wheel scrolling. Caret-in-view "as it moves" (REQ-029) is enforced
// upstream in the reducer's followCaretScroll, not at paint.
export function computeEditorScrollTop(params: {
  lineCount: number;
  height: number;
  scrollTop: number;
}): number {
  return clampScrollToDocument(params.scrollTop, params.height, params.lineCount);
}
