import { Box, Text } from 'ink';
import { wrapVisualLines } from '../../core/editor/grapheme-motions.js';
import { selectionRange } from '../../core/editor/editor-state.js';
import { buildEditorRowSegments } from './editor-line-segments.js';
import { caretVisualPosition, computeEditorScrollTop } from './editor-viewport.js';
import { editorStore } from '../../stores/ui/editor.js';
import { useTheme } from '../../components/theme.js';
import type { SegmentType } from '../../components/input/segments.js';
import type { TextStyle } from '../../components/input/controlled-multiline-input.js';

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
          <Text key={rowIndex} wrap="truncate">
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
