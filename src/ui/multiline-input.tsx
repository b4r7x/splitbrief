import { useState, useEffect, useMemo, useRef } from 'react';
import { useInput, type Key } from 'ink';
import { ControlledMultilineInput, normalizeLineEndings } from './controlled-multiline-input.js';
import type { ControlledMultilineInputProps } from './controlled-multiline-input.js';
import { resolveEditAction, applyEditAction } from '../core/text-editing.js';

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

export const MultilineInput = ({
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
}: MultilineInputProps) => {
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
    // Suppress trailing events from multi-byte terminal sequences (e.g. Cmd+Backspace
    // in non-Kitty terminals sends \x15\x15\x7f\x15 parsed as 4 separate events)
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
        suppressUntilRef.current = Date.now() + 50;
      }
      return;
    }

    let nextPasteLength = 0;
    if (input.length > 1) {
      nextPasteLength = input.length;
    }

    if (key.upArrow) {
      if (showCursor) {
        const lines = normalizeLineEndings(value).split('\n');
        let currentLineIndex = 0;
        let currentPos = 0;
        let col = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line === undefined) continue;
          const lineLen = line.length;
          const lineEnd = currentPos + lineLen;
          if (cursorIndex >= currentPos && cursorIndex <= lineEnd) {
            currentLineIndex = i;
            col = cursorIndex - currentPos;
            break;
          }
          currentPos = lineEnd + 1;
        }
        if (currentLineIndex > 0) {
          const targetLineIndex = currentLineIndex - 1;
          const targetLine = lines[targetLineIndex];
          if (targetLine !== undefined) {
            const targetLineLen = targetLine.length;
            const newCol = Math.min(col, targetLineLen);
            let newIndex = 0;
            for (let i = 0; i < targetLineIndex; i++) {
              newIndex += lines[i]!.length + 1;
            }
            newIndex += newCol;
            setCursorIndex(newIndex);
            setPasteLength(0);
          }
        }
      }
    } else if (key.downArrow) {
      if (showCursor) {
        const lines = normalizeLineEndings(value).split('\n');
        let currentLineIndex = 0;
        let currentPos = 0;
        let col = 0;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line === undefined) continue;
          const lineLen = line.length;
          const lineEnd = currentPos + lineLen;
          if (cursorIndex >= currentPos && cursorIndex <= lineEnd) {
            currentLineIndex = i;
            col = cursorIndex - currentPos;
            break;
          }
          currentPos = lineEnd + 1;
        }
        if (currentLineIndex < lines.length - 1) {
          const targetLineIndex = currentLineIndex + 1;
          const targetLine = lines[targetLineIndex];
          if (targetLine !== undefined) {
            const targetLineLen = targetLine.length;
            const newCol = Math.min(col, targetLineLen);
            let newIndex = 0;
            for (let i = 0; i < targetLineIndex; i++) {
              newIndex += lines[i]!.length + 1;
            }
            newIndex += newCol;
            setCursorIndex(newIndex);
            setPasteLength(0);
          }
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
    } else if (key.return) {
      const newValue = value.slice(0, cursorIndex) + '\n' + value.slice(cursorIndex);
      onChange(newValue);
      setCursorIndex(cursorIndex + 1);
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
  }, focus);

  const highlight = useMemo(() => {
    if (highlightPastedText && pasteLength > 1) {
      return {
        start: Math.max(0, cursorIndex - pasteLength),
        end: cursorIndex,
      };
    }
    return undefined;
  }, [cursorIndex, pasteLength, highlightPastedText]);

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
};
