import { useLayoutEffect, useRef } from 'react';
import { Box, measureElement, type DOMElement } from 'ink';
import { wrapVisualLines } from '../../core/editor/grapheme-motions.js';
import { editorStore } from '../../stores/ui/editor.js';
import { EditorBufferView } from './editor-buffer-view.js';

const FIELD_MIN_ROWS = 3;
const FIELD_MAX_ROWS = 12;

function clampFieldRows(lineCount: number): number {
  return Math.max(FIELD_MIN_ROWS, Math.min(FIELD_MAX_ROWS, lineCount));
}

// The brief field surface paints through the SAME EditorBufferView as the raw overlay, so its
// wrap oracle is wrapVisualLines — but a field is embedded (its box is narrower than the terminal),
// so it cannot borrow the overlay's terminal-cols width. It measures its own render box and seeds
// layout.columns = width − 1 (reserving the seam-caret column, REQ-054) so the reducer wraps at
// EXACTLY the painted width and algorithm (CON-F). layout.rows is the small bounded viewport the
// reducer scrolls the caret within. Measuring in a layout effect re-runs on content and terminal
// resize; setLayout is idempotent, so a stable measurement cannot loop.
//
// maxRows caps the viewport to the rows the enclosing region actually offers (region height minus
// the identity/error/controls chrome the parent reserves). Without it a tall field would grow to
// FIELD_MAX_ROWS and push the decision controls out of the region's overflow:hidden box at small
// terminals — CON-D requires the total reserved rows stay <= available rows with controls always
// visible. The clamp floors at 1 so a starved region still paints one content row plus its chrome.
export function FieldEditorView({ maxRows }: { maxRows?: number }) {
  const ref = useRef<DOMElement>(null);
  const value = editorStore.use((s) => (s.status === 'open' ? s.value : null));

  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const { width } = measureElement(node);
    if (width <= 0) return;
    const state = editorStore.get();
    if (state.status !== 'open') return;
    const columns = Math.max(1, width - 1);
    const contentRows = clampFieldRows(wrapVisualLines(state.value, columns).length);
    const rows = maxRows === undefined ? contentRows : Math.max(1, Math.min(contentRows, maxRows));
    editorStore.setLayout({ columns, rows });
  });

  if (value === null) return null;

  return (
    <Box ref={ref} width="100%" overflow="hidden">
      <EditorBufferView />
    </Box>
  );
}
