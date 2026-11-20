import { ThemeText as Text, useTheme } from '../theme.js';
import { useEffect, useRef } from 'react';
import { Box } from 'ink';
import { buildSegments, type SegmentType } from './segments.js';
import { computeViewportScroll } from './viewport-scroll.js';
import { wrapWordVisualLines } from '../../core/editor/grapheme-motions.js';
import { truncateTerminalDisplayText } from '../../utils/display-text/truncate.js';
import { segmentsForRowText } from '../../utils/display-text/width.js';

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  color?: string | undefined;
  backgroundColor?: string | undefined;
  inverse?: boolean;
}

export interface ControlledMultilineInputProps {
  value: string;
  rows?: number | undefined;
  maxRows?: number | undefined;
  textStyle?: TextStyle | undefined;
  placeholder?: string | undefined;
  keepPlaceholderWhileFocused?: boolean | undefined;
  mask?: string | undefined;
  showCursor?: boolean | undefined;
  focus?: boolean | undefined;
  cursorIndex?: number | undefined;
  columns: number;
  onVisibleRowsChange?: ((rows: number) => void) | undefined;
}

export function ControlledMultilineInput({
  value,
  rows,
  maxRows,
  textStyle,
  placeholder = '',
  keepPlaceholderWhileFocused,
  mask,
  showCursor = true,
  focus = true,
  cursorIndex = 0,
  columns,
  onVisibleRowsChange,
}: ControlledMultilineInputProps) {
  const t = useTheme();
  const scrollOffsetRef = useRef(0);

  const { preCursor, postCursor } = buildSegments({
    value,
    cursorIndex,
    placeholder,
    focus,
    keepPlaceholderWhileFocused,
    showCursor,
    mask,
  });

  // The paint wraps its own rows, so each row fits `columns` and Ink never wraps one. The caret
  // model (findVisualLineStart, text-editing.ts) wraps the same painted text, tabs expanded,
  // through the same function.
  const parts = [...preCursor, ...postCursor].map((segment) => ({
    text: segment.value,
    type: segment.type,
  }));
  const cursorAt = preCursor.findIndex((segment) => segment.type === 'cursor');
  const caretOffset = (cursorAt === -1 ? preCursor : preCursor.slice(0, cursorAt)).reduce(
    (sum, segment) => sum + segment.value.length,
    0,
  );
  const visualRows = wrapWordVisualLines(
    parts.map((part) => part.text).join(''),
    columns,
    preCursor[cursorAt]?.value ? caretOffset : -1,
  );
  const contentHeight = visualRows.length;
  const placeholderAtTop = value === '' && !focus;
  const markerHeight = placeholderAtTop
    ? 1
    : visualRows.findLastIndex((row) => row.start <= caretOffset) + 1;

  const minRows = rows ?? maxRows ?? 1;
  const capRows = maxRows ?? rows ?? 1;
  const effectiveVisibleRows = Math.max(minRows, Math.min(capRows, contentHeight));

  const clipped = placeholderAtTop && contentHeight > effectiveVisibleRows;
  const paintedParts = (clipped ? visualRows.slice(0, effectiveVisibleRows) : visualRows).flatMap(
    (row, index) => [
      ...(index === 0 ? [] : [{ text: '\n', type: undefined }]),
      ...(clipped && index === effectiveVisibleRows - 1
        ? [
            {
              text: truncateTerminalDisplayText(row.text.trimEnd() + '…', columns),
              type: 'placeholder' as const,
            },
          ]
        : segmentsForRowText(parts, row.text, row.start)),
    ],
  );
  useEffect(() => {
    onVisibleRowsChange?.(effectiveVisibleRows);
  }, [effectiveVisibleRows, onVisibleRowsChange]);

  const scrollOffset = computeViewportScroll({
    previous: scrollOffsetRef.current,
    markerHeight,
    visibleRows: effectiveVisibleRows,
    contentHeight,
  });

  useEffect(() => {
    scrollOffsetRef.current = scrollOffset;
  }, [scrollOffset]);

  const getStyle = (type: SegmentType): TextStyle => {
    switch (type) {
      case 'placeholder':
        return { ...textStyle, color: t.textDim };
      case 'cursor':
        return showCursor && focus
          ? { ...textStyle, backgroundColor: t.cursor.bg, color: t.cursor.fg }
          : (textStyle ?? {});
      default:
        return textStyle ?? {};
    }
  };

  return (
    <Box
      height={effectiveVisibleRows}
      overflow="hidden"
      flexDirection="column"
      flexGrow={0}
      flexShrink={0}
    >
      <Box marginTop={-scrollOffset} flexDirection="column" flexShrink={0}>
        <Text>
          {paintedParts.map((part, idx) => (
            <Text key={idx} {...getStyle(part.type)}>
              {part.text}
            </Text>
          ))}
        </Text>
      </Box>
    </Box>
  );
}
