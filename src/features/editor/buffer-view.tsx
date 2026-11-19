import { Box } from 'ink';
import { ThemeText as Text, useTheme } from '../../components/theme.js';
import {
  visualPositionOf,
  wrapVisualLines,
  type EditorAffinity,
  type VisualLine,
} from '../../core/editor/grapheme-motions.js';
import { clampScrollToDocument, selectionRange } from '../../core/editor/state.js';
import { buildEditorRowSegments } from './line-segments.js';
import { editorStore } from '../../stores/ui/editor.js';
import type { SegmentType } from '../../components/input/segments.js';
import type { TextStyle } from '../../components/input/view.js';

// The one shared paint path for both editor surfaces (raw overlay + inline brief field). It
// pre-wraps session.value with wrapVisualLines at session.layout.columns and paints each visual
// line with buildEditorRowSegments, so the painted grid is byte-for-byte the reducer's wrap
// oracle (CON-F). The caller owns layout.columns; keeping model ≡ paint is the caller's job of
// feeding the ACTUAL render width into layout.columns (raw overlay: terminal cols − 1; field:
// measured box width − 1).
export function EditorBufferView() {
  const t = useTheme();
  const session = editorStore.use((s) => (s.status === 'open' ? s : null));
  if (session === null) return null;

  const columns = session.layout.columns;
  const height = session.layout.rows;
  const lines = wrapVisualLines(session.value, columns);
  const { row: caretRow, col: caretCol } = caretVisualPosition(
    lines,
    session.cursor,
    session.affinity,
  );
  const scrollTop = computeEditorScrollTop({
    lineCount: lines.length,
    height,
    scrollTop: session.scrollTop,
  });
  const selection = selectionRange(session);
  const visible = lines.slice(scrollTop, scrollTop + height);

  const styleFor = (type: SegmentType): TextStyle => {
    switch (type) {
      case 'highlight':
        return { backgroundColor: t.highlight.bg, color: t.highlight.fg };
      case 'cursor':
        return { backgroundColor: t.cursor.bg, color: t.cursor.fg };
      default:
        return {};
    }
  };

  return (
    <Box flexDirection="column" width={columns + 1} height={height} overflow="hidden">
      {visible.map((line, i) => {
        const rowIndex = scrollTop + i;
        const segments = buildEditorRowSegments(line, {
          caretCol: rowIndex === caretRow ? caretCol : null,
          selection,
        });
        return (
          <Text key={rowIndex} color={t.text} wrap="truncate">
            {segments.length === 0
              ? ' '
              : segments.map((segment, j) => (
                  <Text key={j} {...styleFor(segment.type)}>
                    {segment.value}
                  </Text>
                ))}
          </Text>
        );
      })}
    </Box>
  );
}

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
