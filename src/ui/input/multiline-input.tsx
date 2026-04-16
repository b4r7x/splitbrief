import { useEffect, useRef, useState } from 'react';
import { Box, Spacer, Text, useInput, type Key } from 'ink';
import { buildSegments, normalizeLineEndings, type SegmentType } from './segments.js';
import { resolveEditAction, applyEditAction, navigateVertically } from './text-editing.js';
import { computeViewportScroll } from './viewport-scroll.js';
import { useTheme } from '../theme.js';
import { MeasureBox } from './measure-box.js';

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

interface ControlledMultilineInputProps {
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
  ].join('|');
  const markerMeasureKey = `${cursorIndex}|${focus ? 1 : 0}|${showCursor ? 1 : 0}|${measureColumns ?? 0}`;

  useEffect(() => {
    onVisibleRowsChange?.(effectiveVisibleRows);
  }, [effectiveVisibleRows, onVisibleRowsChange]);

  // Derived during render via ref to avoid a derived-state useEffect.
  const scrollOffset = computeViewportScroll({
    previous: scrollOffsetRef.current,
    markerHeight,
    visibleRows: effectiveVisibleRows,
    contentHeight,
  });
  scrollOffsetRef.current = scrollOffset;

  const resolvedHighlightStyle: TextStyle = highlightStyle ?? { backgroundColor: t.highlight.bg, color: t.highlight.fg };

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
    <Box height={effectiveVisibleRows} overflow="hidden" flexDirection="column" flexGrow={0} flexShrink={0}>
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

interface MultilineInputProps extends ControlledMultilineInputProps {
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  columns?: number;
  keyBindings?: {
    submit?: (key: Key) => boolean;
    newline?: (key: Key) => boolean;
  };
  highlightPastedText?: boolean;
  focus?: boolean;
  onBoundaryNavigate?: ((direction: 'up' | 'down') => boolean | undefined) | undefined;
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
  onBoundaryNavigate,
  ...controlledProps
}: MultilineInputProps) {
  const [rawCursorIndex, setCursorIndex] = useState(value.length);
  const [pasteLength, setPasteLength] = useState(0);
  // Suppress rapid-fire key events after delete-line-backward (Cmd+Backspace
  // in non-Kitty terminals sends multiple raw bytes parsed as separate events)
  const suppressUntilRef = useRef(0);

  // Clamp during render so stale cursor from a shrinking `value` prop is corrected.
  const cursorIndex = Math.min(rawCursorIndex, value.length);

  useInput((input, key) => {
    if (Date.now() < suppressUntilRef.current) return;

    // Let scroll keys pass through to global handler
    if (key.shift && (key.upArrow || key.downArrow)) return;
    if (key.pageUp || key.pageDown) return;

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

    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      if (!showCursor) return;
    }

    if (key.upArrow) {
      const newIndex = navigateVertically('up', value, cursorIndex);
      if (newIndex !== undefined) {
        setCursorIndex(newIndex);
        setPasteLength(0);
        return;
      }
      if (onBoundaryNavigate?.('up')) {
        setPasteLength(0);
      }
    } else if (key.downArrow) {
      const newIndex = navigateVertically('down', value, cursorIndex);
      if (newIndex !== undefined) {
        setCursorIndex(newIndex);
        setPasteLength(0);
        return;
      }
      if (onBoundaryNavigate?.('down')) {
        setPasteLength(0);
      }
    } else if (key.leftArrow) {
      setCursorIndex(Math.max(0, cursorIndex - 1));
      setPasteLength(0);
    } else if (key.rightArrow) {
      setCursorIndex(Math.min(value.length, cursorIndex + 1));
      setPasteLength(0);
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
  }, { isActive: focus });

  const highlight = highlightPastedText && pasteLength > 1
    ? { start: Math.max(0, cursorIndex - pasteLength), end: cursorIndex }
    : undefined;

  return (
    <ControlledMultilineInput
      {...controlledProps}
      value={value}
      cursorIndex={cursorIndex}
      highlight={highlight}
      measureColumns={columns}
      showCursor={showCursor}
      focus={focus}
    />
  );
}
