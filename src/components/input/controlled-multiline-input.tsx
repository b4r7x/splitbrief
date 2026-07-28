import { useEffect, useRef, useState } from 'react';
import { Box, Spacer, Text } from 'ink';
import { buildSegments, type SegmentType } from './segments.js';
import { computeViewportScroll } from './viewport-scroll.js';
import { useTheme } from '../theme.js';
import { MeasureBox } from './measure-box.js';

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  dimColor?: boolean;
  color?: string;
  backgroundColor?: string;
  inverse?: boolean;
}

export interface ControlledMultilineInputProps {
  value: string;
  rows?: number | undefined;
  maxRows?: number | undefined;
  highlightStyle?: TextStyle | undefined;
  textStyle?: TextStyle | undefined;
  placeholder?: string | undefined;
  mask?: string | undefined;
  showCursor?: boolean | undefined;
  focus?: boolean | undefined;
  tabSize?: number | undefined;
  cursorIndex?: number | undefined;
  highlight?: { start: number; end: number } | undefined;
  measureColumns?: number | undefined;
  onVisibleRowsChange?: ((rows: number) => void) | undefined;
}

export function ControlledMultilineInput({
  value,
  rows,
  maxRows,
  highlightStyle,
  textStyle,
  placeholder = '',
  mask,
  showCursor = true,
  focus = true,
  tabSize = 4,
  cursorIndex = 0,
  highlight,
  measureColumns,
  onVisibleRowsChange,
}: ControlledMultilineInputProps) {
  const t = useTheme();
  const scrollOffsetRef = useRef(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [markerHeight, setMarkerHeight] = useState(0);

  const { preCursor, postCursor } = buildSegments({
    value,
    cursorIndex,
    placeholder,
    focus,
    showCursor,
    mask,
    tabSize,
    highlight,
  });

  const minRows = rows ?? maxRows ?? 1;
  const capRows = maxRows ?? rows ?? 1;
  const effectiveVisibleRows = Math.max(minRows, Math.min(capRows, contentHeight));
  const contentMeasureKey = [
    value,
    cursorIndex,
    focus ? 1 : 0,
    showCursor ? 1 : 0,
    placeholder,
    mask ?? '',
    highlight?.start ?? -1,
    highlight?.end ?? -1,
    measureColumns ?? 0,
    tabSize,
  ].join('|');
  const markerMeasureKey = [
    value,
    cursorIndex,
    focus ? 1 : 0,
    showCursor ? 1 : 0,
    mask ?? '',
    measureColumns ?? 0,
    tabSize,
  ].join('|');

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

  const resolvedHighlightStyle: TextStyle = highlightStyle ?? {
    backgroundColor: t.highlight.bg,
    color: t.highlight.fg,
  };

  const getStyle = (type: SegmentType): TextStyle => {
    switch (type) {
      case 'placeholder':
        return { ...textStyle, dimColor: true };
      case 'highlight':
        return resolvedHighlightStyle;
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
      <Box flexDirection="column">
        <Box height={effectiveVisibleRows} overflowY="hidden" flexShrink={0} flexDirection="column">
          <Box marginTop={-scrollOffset} flexDirection="column">
            <MeasureBox onHeightChange={setContentHeight} measureKey={contentMeasureKey}>
              <Text>
                {preCursor?.map((segment, idx) => (
                  <Text key={`pre-${idx}`} {...getStyle(segment.type)}>
                    {segment.value}
                  </Text>
                ))}
                {postCursor?.map((segment, idx) => (
                  <Text key={`post-${idx}`} {...getStyle(segment.type)}>
                    {segment.value}
                  </Text>
                ))}
              </Text>
            </MeasureBox>
          </Box>
          <Spacer />
        </Box>
        <MeasureBox onHeightChange={setMarkerHeight} measureKey={markerMeasureKey}>
          <Text>
            {preCursor?.map((segment, idx) => (
              <Text key={`marker-${idx}`} {...getStyle(segment.type)}>
                {segment.value}
              </Text>
            ))}
          </Text>
        </MeasureBox>
      </Box>
    </Box>
  );
}
