import { useState, useEffect, useRef, type ReactNode } from 'react';
import { Box, Spacer, Text, measureElement } from 'ink';

function expandTabs(text: string, tabSize: number): string {
  return text.replace(/\t/g, ' '.repeat(tabSize));
}

export function normalizeLineEndings(text: string | null | undefined): string {
  if (text == null) {
    return '';
  }
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

type SegmentType = 'placeholder' | 'highlight' | 'cursor' | undefined;

interface Segment {
  value: string;
  type?: SegmentType;
}

interface TextStyle {
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
  rows?: number;
  maxRows?: number;
  highlightStyle?: TextStyle;
  textStyle?: TextStyle;
  placeholder?: string;
  mask?: string;
  showCursor?: boolean;
  focus?: boolean;
  tabSize?: number;
  cursorIndex?: number;
  highlight?: { start: number; end: number };
  refreshKey?: string | number;
}

const MeasureBox = ({ children, onHeightChange }: { children: ReactNode; onHeightChange?: (height: number) => void }) => {
  const ref = useRef<any>(null);
  const lastHeightRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (ref.current) {
      const { height } = measureElement(ref.current);
      if (lastHeightRef.current !== height) {
        lastHeightRef.current = height;
        onHeightChange?.(height);
      }
    }
  });
  return <Box ref={ref} flexShrink={0} flexGrow={0} width="100%">{children}</Box>;
};

export const ControlledMultilineInput = ({
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
  refreshKey,
}: ControlledMultilineInputProps) => {
  const [scrollOffset, setScrollOffset] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const [markerHeight, setMarkerHeight] = useState(0);

  const formatText = (text: string, isPlaceholder = false) => {
    const normalized = normalizeLineEndings(text);
    if (!isPlaceholder && mask) {
      return normalized.replace(/[^\n]/g, mask);
    }
    return expandTabs(normalized, tabSize);
  };

  const { preCursor, postCursor } = ((): { preCursor: Segment[]; postCursor: Segment[] } => {
    if (!value) {
      if (placeholder && !focus) {
        return {
          preCursor: [{ value: formatText(placeholder, true), type: 'placeholder' }],
          postCursor: [],
        };
      }
      return {
        preCursor: [{ value: ' ', type: 'cursor' }],
        postCursor: [],
      };
    }

    const textBefore = value.slice(0, cursorIndex);
    const textAfter = value.slice(cursorIndex);

    if (!focus) {
      return {
        preCursor: [{ value: formatText(value) }],
        postCursor: [],
      };
    }

    const hasValidHighlight =
      highlight &&
      highlight.end > highlight.start &&
      highlight.start >= 0 &&
      highlight.end <= value.length;

    if (!hasValidHighlight) {
      const formattedBefore = formatText(textBefore);
      const formattedAfter = formatText(textAfter);
      const lineStart = formattedBefore.lastIndexOf('\n') + 1;
      const lineEnd = formattedAfter.indexOf('\n');
      return {
        preCursor: [
          { value: formattedBefore.slice(0, lineStart) },
          { value: formattedBefore.slice(lineStart), type: 'highlight' },
          { value: showCursor && focus ? ' ' : '', type: 'cursor' },
        ],
        postCursor: [
          { value: formattedAfter.slice(0, lineEnd), type: 'highlight' },
          { value: formattedAfter.slice(lineEnd) },
        ],
      };
    } else {
      return {
        preCursor: [
          { value: formatText(textBefore.slice(0, highlight.start)) },
          {
            value: formatText(
              textBefore.slice(highlight.start, Math.min(highlight.end, cursorIndex)),
            ),
            type: 'highlight',
          },
          { value: formatText(textBefore.slice(highlight.end)) },
          { value: ' ', type: 'cursor' },
        ],
        postCursor: [
          {
            value: formatText(
              textAfter.slice(0, Math.max(highlight.start - cursorIndex, 0)),
            ),
          },
          {
            value: formatText(
              textAfter.slice(
                Math.max(highlight.start - cursorIndex, 0),
                Math.max(highlight.end - cursorIndex, 0),
              ),
            ),
            type: 'highlight',
          },
          {
            value: formatText(
              textAfter.slice(Math.max(highlight.end - cursorIndex, 0)),
            ),
          },
        ],
      };
    }
  })();

  const visibleRows = contentHeight !== undefined
    ? Math.max(rows ?? maxRows ?? 1, Math.min(maxRows ?? rows ?? 1, contentHeight))
    : 1;

  useEffect(() => {
    if (markerHeight !== undefined && visibleRows !== undefined) {
      const cursorLineEnd = markerHeight;
      setScrollOffset((prevOffset) => {
        const viewportStart = prevOffset;
        const viewportEnd = prevOffset + visibleRows;
        if (cursorLineEnd <= viewportStart) {
          return Math.max(0, cursorLineEnd - 1);
        } else if (cursorLineEnd > viewportEnd) {
          return cursorLineEnd - visibleRows;
        } else if (contentHeight) {
          if (contentHeight < visibleRows) {
            return 0;
          } else if (contentHeight < viewportEnd) {
            return contentHeight - visibleRows;
          }
        }
        return prevOffset;
      });
    }
  }, [markerHeight, visibleRows, contentHeight]);

  const getStyle = (type: SegmentType): TextStyle => {
    switch (type) {
      case 'placeholder':
        return { ...textStyle, dimColor: true };
      case 'highlight':
        return highlightStyle ?? textStyle ?? {};
      case 'cursor':
        return {
          ...(highlightStyle ?? textStyle),
          inverse: showCursor && focus,
        };
      default:
        return textStyle ?? {};
    }
  };

  return (
    <Box height={visibleRows} overflow="hidden" flexDirection="column" flexGrow={0} flexShrink={0}>
      <Box flexDirection="column">
        <Box height={visibleRows} overflowY="hidden" flexShrink={0} flexDirection="column">
          <Box marginTop={-scrollOffset} flexDirection="column">
            <MeasureBox onHeightChange={setContentHeight}>
              <Text>
                {preCursor?.map((segment, idx) => (
                  <Text key={idx} {...getStyle(segment.type)}>
                    {segment.value}
                  </Text>
                ))}
                {postCursor?.map((segment, idx) => (
                  <Text key={idx} {...getStyle(segment.type)}>
                    {segment.value}
                  </Text>
                ))}
              </Text>
            </MeasureBox>
          </Box>
          <Spacer />
        </Box>
        <MeasureBox onHeightChange={setMarkerHeight}>
          <Text>
            {preCursor?.map((segment, idx) => (
              <Text key={idx} {...getStyle(segment.type)}>
                {segment.value}
              </Text>
            ))}
          </Text>
        </MeasureBox>
      </Box>
    </Box>
  );
};
