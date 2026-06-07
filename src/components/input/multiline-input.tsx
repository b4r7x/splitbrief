import { useRef, useState } from 'react';
import { useInput, type Key } from 'ink';
import { normalizeLineEndings } from './segments.js';
import { resolveEditAction, applyEditAction, navigateVertically } from './text-editing.js';
import {
  ControlledMultilineInput,
  type ControlledMultilineInputProps,
} from './controlled-multiline-input.js';
import { SUPPORTED_IMAGE_EXTS } from '../../core/schemas/attachment.js';

const MULTI_BYTE_SUPPRESS_MS = 50;

const FILE_DROP_EXT_PATTERN = new RegExp(`\\.(${SUPPORTED_IMAGE_EXTS.join('|')})$`, 'i');

function parseDroppedImagePath(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes('\n')) return null;
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  if (!unquoted || !FILE_DROP_EXT_PATTERN.test(unquoted)) return null;
  return unquoted;
}

interface MultilineInputProps extends ControlledMultilineInputProps {
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onFileDrop?: (path: string) => void;
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
  onFileDrop,
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

  const cursorIndex = Math.min(rawCursorIndex, value.length);

  useInput(
    (input, key) => {
      if (Date.now() < suppressUntilRef.current) return;

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

      if (input.length > 1 && onFileDrop) {
        const droppedPath = parseDroppedImagePath(input);
        if (droppedPath) {
          onFileDrop(droppedPath);
          return;
        }
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

      if (key.ctrl) return;

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
    },
    { isActive: focus },
  );

  const highlight =
    highlightPastedText && pasteLength > 1
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
