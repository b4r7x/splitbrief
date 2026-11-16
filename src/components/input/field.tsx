import { useEffect, useRef, useState } from 'react';
import { useInput, useStdin, type Key } from 'ink';
import { normalizeLineEndings } from './segments.js';
import {
  resolveEditAction,
  applyEditAction,
  navigateVertically,
  prevGraphemeBoundary,
  nextGraphemeBoundary,
} from './text-editing.js';
import { ControlledMultilineInput, type ControlledMultilineInputProps } from './view.js';
import { isTerminalControlRun } from '../../lib/terminal/text-entry.js';
import { sanitizePasteBody } from '../../lib/terminal/filtered-stdin/paste.js';
import { SUPPORTED_IMAGE_EXTS } from '../../core/schemas/attachment.js';
import {
  expandEditOverAtoms,
  resolveInputEdit,
  snapCaretOutOfAtoms,
  type InputAtom,
  type InputEdit,
} from './atoms.js';

const MULTI_BYTE_SUPPRESS_MS = 50;

const FILE_DROP_EXT_PATTERN = new RegExp(`\\.(${SUPPORTED_IMAGE_EXTS.join('|')})$`, 'i');

function parseDroppedImagePath(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.includes('\n')) return null;
  const token = trimmed.match(/^(?:"([^"]*)"|'([^']*)'|((?:\\[\s\S]|[^\s"'\\])+))$/);
  if (!token) return null;
  const unquoted = token[1] ?? token[2] ?? token[3]?.replace(/\\([\s\S])/g, '$1');
  if (!unquoted || unquoted.startsWith('@') || !FILE_DROP_EXT_PATTERN.test(unquoted)) return null;
  return unquoted;
}

const NO_ATOMS: readonly InputAtom[] = [];

interface MultilineInputProps extends ControlledMultilineInputProps {
  onChange: (value: string, edit: InputEdit) => void;
  onSubmit?: (value: string) => void;
  onFileDrop?: (path: string) => void;
  /** Only completed bracketed paste; true transfers insertion to the caller. */
  onPaste?: ((text: string, caret: number) => boolean) | undefined;
  /** Spans of `value` that are one unit to the caret and to every delete. */
  atoms?: readonly InputAtom[] | undefined;
  /** Where the caret starts on a mount and on a new start; the end of the value when unset. */
  initialCursorIndex?: number | undefined;
  /**
   * A new value starts the field again, as a mount does: the caret, the key suppression and the
   * scroll of the paint. The field keeps its key listener, so a key read before the next effects
   * reaches the new start.
   */
  resetKey?: string | number | undefined;
  onCursorChange?: ((index: number) => void) | undefined;
  keyBindings?: {
    submit?: (key: Key) => boolean;
    newline?: (key: Key) => boolean;
    shortcut?: (input: string, key: Key) => boolean;
  };
  onShortcut?: () => void;
  focus?: boolean;
  isActive?: boolean;
  shouldHandleInput?: ((input: string, key: Key) => boolean) | undefined;
  onBoundaryNavigate?: ((direction: 'up' | 'down') => void) | undefined;
}

export function MultilineInput({
  value,
  onChange,
  onSubmit,
  onFileDrop,
  onPaste,
  onShortcut,
  atoms,
  initialCursorIndex,
  resetKey,
  onCursorChange,
  columns,
  keyBindings,
  showCursor = true,
  focus = true,
  isActive = focus,
  shouldHandleInput,
  onBoundaryNavigate,
  ...controlledProps
}: MultilineInputProps) {
  const [startKey, setStartKey] = useState(resetKey);
  const [rawCursorIndex, setCursorIndex] = useState(initialCursorIndex ?? value.length);
  // Suppress rapid-fire key events after delete-line-backward (Cmd+Backspace
  // in non-Kitty terminals sends multiple raw bytes parsed as separate events)
  const suppressUntilRef = useRef(0);
  const { stdin } = useStdin();

  const atomList = atoms ?? NO_ATOMS;
  const caretAt = (index: number) =>
    snapCaretOutOfAtoms(atomList, Math.min(index, value.length), 'backward');
  const cursorIndex = caretAt(rawCursorIndex);
  const valueRef = useRef(value);
  const propValueRef = useRef(value);
  const cursorRef = useRef(cursorIndex);
  if (propValueRef.current !== value) {
    propValueRef.current = value;
    if (valueRef.current !== value) valueRef.current = value;
  }
  // A key read before the next effects runs the handler of the last render, which reads the value
  // and the caret from the refs, so the new start writes the refs in this render.
  if (startKey !== resetKey) {
    setStartKey(resetKey);
    setCursorIndex(initialCursorIndex ?? value.length);
    valueRef.current = value;
    cursorRef.current = caretAt(initialCursorIndex ?? value.length);
    suppressUntilRef.current = 0;
  }

  useEffect(() => {
    onCursorChange?.(cursorIndex);
  }, [cursorIndex]);

  // One door out of every editing branch: the branch proposes a string, this turns it back into the
  // range it really changed, grows that range over any atom it touched, and reports both.
  const commit = (nextValue: string, nextCursor: number) => {
    const currentValue = valueRef.current;
    const currentCursor = cursorRef.current;
    const edit: InputEdit = {
      ...expandEditOverAtoms(atomList, resolveInputEdit(currentValue, nextValue, nextCursor)),
      caret: currentCursor,
    };
    const merged = currentValue.slice(0, edit.start) + edit.text + currentValue.slice(edit.end);
    const caret = edit.start + edit.text.length;
    const nextCursorIndex = snapCaretOutOfAtoms(
      atomList,
      caret,
      caret < currentCursor ? 'backward' : 'forward',
    );
    valueRef.current = merged;
    cursorRef.current = nextCursorIndex;
    setCursorIndex(nextCursorIndex);
    onChange(merged, edit);
  };

  const moveCaret = (index: number, prefer: 'backward' | 'forward') => {
    const nextCursorIndex = snapCaretOutOfAtoms(atomList, index, prefer);
    cursorRef.current = nextCursorIndex;
    setCursorIndex(nextCursorIndex);
  };

  useEffect(() => {
    if (!isActive) return;
    const handlePaste = (text: string) => {
      const droppedPath = onFileDrop ? parseDroppedImagePath(text) : null;
      if (droppedPath !== null) {
        onFileDrop?.(droppedPath);
        return;
      }
      if (onPaste?.(text, cursorRef.current)) return;
      const normalized = normalizeLineEndings(text).normalize('NFC');
      const currentValue = valueRef.current;
      const currentCursor = cursorRef.current;
      commit(
        currentValue.slice(0, currentCursor) + normalized + currentValue.slice(currentCursor),
        currentCursor + normalized.length,
      );
    };
    stdin.on('paste', handlePaste);
    return () => {
      stdin.off('paste', handlePaste);
    };
  }, [stdin, isActive, value, cursorIndex, onPaste, onFileDrop]);

  const handleInput = (input: string, key: Key) => {
    const currentValue = valueRef.current;
    const currentCursor = cursorRef.current;
    if (shouldHandleInput !== undefined && !shouldHandleInput(input, key)) return;
    // The suppression window drops the tail bytes of a multi-byte delete, never a key the caller
    // bound explicitly: Ctrl+E right after Ctrl+U still opens the editor.
    if (keyBindings?.shortcut?.(input, key)) {
      onShortcut?.();
      return;
    }
    if (Date.now() < suppressUntilRef.current) return;

    if (key.shift && (key.upArrow || key.downArrow)) return;
    if (key.pageUp || key.pageDown) return;
    if (key.home || key.end) return;

    const submitKey = keyBindings?.submit ?? ((k: Key) => k.return && k.ctrl);
    const newlineKey = keyBindings?.newline ?? ((k: Key) => k.return);

    if (submitKey(key)) {
      onSubmit?.(currentValue);
      return;
    } else if (newlineKey(key)) {
      commit(
        currentValue.slice(0, currentCursor) + '\n' + currentValue.slice(currentCursor),
        currentCursor + 1,
      );
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
    const editResult = applyEditAction({
      action,
      value: currentValue,
      cursor: currentCursor,
      columns,
    });
    if (editResult) {
      commit(editResult.value, editResult.cursor);
      if (action === 'delete-line-backward' && editResult.value !== currentValue) {
        suppressUntilRef.current = Date.now() + MULTI_BYTE_SUPPRESS_MS;
      }
      return;
    }

    if (key.ctrl || key.meta || key.super || key.hyper) return;

    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      if (!showCursor) return;
    }

    if (key.upArrow) {
      const newIndex = navigateVertically({
        direction: 'up',
        value: currentValue,
        cursorIndex: currentCursor,
      });
      if (newIndex !== undefined) {
        moveCaret(newIndex, 'backward');
        return;
      }
      onBoundaryNavigate?.('up');
    } else if (key.downArrow) {
      const newIndex = navigateVertically({
        direction: 'down',
        value: currentValue,
        cursorIndex: currentCursor,
      });
      if (newIndex !== undefined) {
        moveCaret(newIndex, 'forward');
        return;
      }
      onBoundaryNavigate?.('down');
    } else if (key.leftArrow) {
      moveCaret(prevGraphemeBoundary(currentValue, currentCursor), 'backward');
    } else if (key.rightArrow) {
      moveCaret(nextGraphemeBoundary(currentValue, currentCursor), 'forward');
    } else if (key.backspace || key.delete) {
      if (currentCursor > 0) {
        const prev = prevGraphemeBoundary(currentValue, currentCursor);
        commit(currentValue.slice(0, prev) + currentValue.slice(currentCursor), prev);
      }
    } else {
      // A C0 control byte (e.g. Ctrl+/ as `\x1f` on legacy terminals), alone or in a run a late
      // read delivered together, is a chord the global handler owns, not text — inserting it
      // would corrupt the draft. Read together with typed text (`fix\x03\x03`), it is dropped
      // from that text, which keeps only what a paste may carry.
      if (isTerminalControlRun(input)) return;
      const normalized = sanitizePasteBody(input).normalize('NFC');
      if (normalized) {
        const newValue =
          currentValue.slice(0, currentCursor) + normalized + currentValue.slice(currentCursor);
        commit(newValue, currentCursor + normalized.length);
      }
    }
  };

  useInput(handleInput, { isActive });

  return (
    <ControlledMultilineInput
      key={resetKey}
      {...controlledProps}
      value={value}
      cursorIndex={cursorIndex}
      columns={columns}
      showCursor={showCursor}
      focus={focus}
    />
  );
}
