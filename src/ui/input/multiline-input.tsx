import { useState, useEffect, useRef, type ReactNode } from 'react';
import { Box, Spacer, Text, useInput, measureElement, type DOMElement, type Key } from 'ink';
import { buildSegments, normalizeLineEndings, type SegmentType } from './segments.js';
import { resolveEditAction, applyEditAction, navigateVertically } from './text-editing.js';

const MULTI_BYTE_SUPPRESS_MS = 50;

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

function MeasureBox({ children, onHeightChange }: { children: ReactNode; onHeightChange?: (height: number) => void }) {
  const ref = useRef<DOMElement>(null);
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
}

interface ControlledMultilineInputProps {
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

function ControlledMultilineInput({
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
}: ControlledMultilineInputProps) {
  const [scrollOffset, setScrollOffset] = useState(0);
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
}

export interface MultilineInputProps extends ControlledMultilineInputProps {
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  columns?: number;
  useCustomInput?: (handler: (input: string, key: Key) => void, isActive: boolean) => void;
  keyBindings?: {
    submit?: (key: Key) => boolean;
    newline?: (key: Key) => boolean;
  };
  highlightPastedText?: boolean;
  focus?: boolean;
}

export function MultilineInput({
  value,
  onChange,
  onSubmit,
  columns,
  keyBindings,
  showCursor = true,
  highlightPastedText = false,
  focus = true,
  useCustomInput = (handler: (input: string, key: Key) => void, isActive: boolean) => useInput(handler, { isActive }),
  ...controlledProps
}: MultilineInputProps) {
  const [cursorIndex, setCursorIndex] = useState(value.length);
  const [pasteLength, setPasteLength] = useState(0);
  // Suppress rapid-fire key events after delete-line-backward (Cmd+Backspace
  // in non-Kitty terminals sends multiple raw bytes parsed as separate events)
  const suppressUntilRef = useRef(0);

  useEffect(() => {
    if (cursorIndex > value.length) {
      setCursorIndex(value.length);
    }
  }, [value, cursorIndex]);

  useCustomInput((input, key) => {
    if (Date.now() < suppressUntilRef.current) return;

    const submitKey = keyBindings?.submit ?? ((k: Key) => k.return && k.ctrl);
    const newlineKey = keyBindings?.newline ?? ((k: Key) => k.return);

    if (submitKey(key)) {
      onSubmit?.(value);
      return;
    } else if (newlineKey(key)) {
      const newValue = value.slice(0, cursorIndex) + '\n' + value.slice(cursorIndex);
      onChange(newValue);
      setCursorIndex(cursorIndex + 1);
      setPasteLength(0);
      return;
    }

    if (key.tab || (key.shift && key.tab) || (key.ctrl && input === 'c')) {
      return;
    }

    const action = resolveEditAction(input, key);
    const editResult = applyEditAction(action, value, cursorIndex, columns);
    if (editResult) {
      onChange(editResult.value);
      setCursorIndex(editResult.cursor);
      setPasteLength(0);
      if (action === 'delete-line-backward' && editResult.value !== value) {
        suppressUntilRef.current = Date.now() + MULTI_BYTE_SUPPRESS_MS;
      }
      return;
    }

    let nextPasteLength = 0;
    if (input.length > 1) {
      nextPasteLength = input.length;
    }

    if (key.upArrow) {
      if (showCursor) {
        const newIndex = navigateVertically('up', value, cursorIndex);
        if (newIndex !== undefined) {
          setCursorIndex(newIndex);
          setPasteLength(0);
        }
      }
    } else if (key.downArrow) {
      if (showCursor) {
        const newIndex = navigateVertically('down', value, cursorIndex);
        if (newIndex !== undefined) {
          setCursorIndex(newIndex);
          setPasteLength(0);
        }
      }
    } else if (key.leftArrow) {
      if (showCursor) {
        setCursorIndex(Math.max(0, cursorIndex - 1));
        setPasteLength(0);
      }
    } else if (key.rightArrow) {
      if (showCursor) {
        setCursorIndex(Math.min(value.length, cursorIndex + 1));
        setPasteLength(0);
      }
    } else if (key.backspace || key.delete) {
      if (cursorIndex > 0) {
        onChange(value.slice(0, cursorIndex - 1) + value.slice(cursorIndex));
        setCursorIndex(cursorIndex - 1);
        setPasteLength(0);
      }
    } else {
      if (input) {
        const normalized = normalizeLineEndings(input).normalize('NFC');
        const newValue = value.slice(0, cursorIndex) + normalized + value.slice(cursorIndex);
        onChange(newValue);
        setCursorIndex(cursorIndex + normalized.length);
        setPasteLength(nextPasteLength);
      }
    }
  }, focus);

  const highlight = highlightPastedText && pasteLength > 1
    ? { start: Math.max(0, cursorIndex - pasteLength), end: cursorIndex }
    : undefined;

  return (
    <ControlledMultilineInput
      {...controlledProps}
      value={value}
      cursorIndex={cursorIndex}
      highlight={highlight}
      showCursor={showCursor}
      focus={focus}
    />
  );
}
