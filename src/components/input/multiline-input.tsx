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
import {
  ControlledMultilineInput,
  type ControlledMultilineInputProps,
} from './controlled-multiline-input.js';
import { isTerminalControlRun } from '../../lib/terminal/text-entry.js';
import { sanitizePasteBody } from '../../lib/terminal/filtered-stdin/paste.js';
import { SUPPORTED_IMAGE_EXTS } from '../../core/schemas/attachment.js';

const MULTI_BYTE_SUPPRESS_MS = 50;
const RAW_BACKSPACE = '\x7f';

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

/** An indivisible span of `value`: the caret never lands inside it and an edit takes all of it. */
export interface InputAtom {
  start: number;
  end: number;
}

/** The change an input event made to `value`, as a range replacement rather than a new string. */
export interface InputEdit {
  start: number;
  end: number;
  text: string;
}

const NO_ATOMS: readonly InputAtom[] = [];

// Every key this component handles rewrites one contiguous span, so the change can be recovered as
// a range instead of guessed from a whole-string diff. Where several ranges would produce the same
// string (deleting one of two adjacent atoms), the caret the edit left behind picks between them.
export function resolveInputEdit(previous: string, next: string, cursor: number): InputEdit {
  const limit = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < limit && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const inserted = next.length - suffix - prefix;
  const removed = previous.length - suffix - prefix;
  if (inserted === 0 && removed === 0) return { start: cursor, end: cursor, text: '' };

  const target = cursor - inserted;
  let start = prefix;
  while (start > target && start > 0 && rebuilds(previous, next, start - 1, inserted, removed)) {
    start -= 1;
  }
  return { start, end: start + removed, text: next.slice(start, start + inserted) };
}

function rebuilds(
  previous: string,
  next: string,
  start: number,
  inserted: number,
  removed: number,
): boolean {
  return (
    previous.slice(0, start) +
      next.slice(start, start + inserted) +
      previous.slice(start + removed) ===
    next
  );
}

export function expandEditOverAtoms(atoms: readonly InputAtom[], edit: InputEdit): InputEdit {
  let start = edit.start;
  let end = edit.end;
  for (const atom of atoms) {
    if (start === end) {
      if (start > atom.start && start < atom.end) {
        start = atom.end;
        end = atom.end;
      }
      continue;
    }
    if (atom.start < end && atom.end > start) {
      start = Math.min(start, atom.start);
      end = Math.max(end, atom.end);
    }
  }
  return { start, end, text: edit.text };
}

function snapCaretOutOfAtoms(
  atoms: readonly InputAtom[],
  index: number,
  prefer: 'backward' | 'forward',
): number {
  for (const atom of atoms) {
    if (index > atom.start && index < atom.end) {
      return prefer === 'backward' ? atom.start : atom.end;
    }
  }
  return index;
}

function useLatestInputSequence() {
  const sequenceRef = useRef('');
  const { internal_eventEmitter } = useStdin();

  useEffect(() => {
    function recordSequence(input: string) {
      sequenceRef.current = input;
    }

    internal_eventEmitter.on('input', recordSequence);
    return () => {
      internal_eventEmitter.off('input', recordSequence);
    };
  }, [internal_eventEmitter]);

  return sequenceRef;
}

interface MultilineInputProps extends ControlledMultilineInputProps {
  onChange: (value: string, edit: InputEdit) => void;
  onSubmit?: (value: string) => void;
  onFileDrop?: (path: string) => void;
  /** Only completed bracketed paste; true transfers insertion to the caller. */
  onPaste?: ((text: string, caret: number) => boolean) | undefined;
  /** Spans of `value` that are one unit to the caret and to every delete. */
  atoms?: readonly InputAtom[] | undefined;
  /** Where the caret starts on a fresh mount; the end of the value when unset. */
  initialCursorIndex?: number | undefined;
  onCursorChange?: ((index: number) => void) | undefined;
  keyBindings?: {
    submit?: (key: Key) => boolean;
    newline?: (key: Key) => boolean;
    shortcut?: (input: string, key: Key) => boolean;
  };
  onShortcut?: () => void;
  highlightPastedText?: boolean;
  focus?: boolean;
  isActive?: boolean;
  shouldHandleInput?: ((input: string, key: Key) => boolean) | undefined;
  onBoundaryNavigate?: ((direction: 'up' | 'down') => boolean | undefined) | undefined;
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
  onCursorChange,
  columns,
  keyBindings,
  showCursor = true,
  highlightPastedText = false,
  focus = true,
  isActive = focus,
  shouldHandleInput,
  onBoundaryNavigate,
  ...controlledProps
}: MultilineInputProps) {
  const [rawCursorIndex, setCursorIndex] = useState(initialCursorIndex ?? value.length);
  const [pasteLength, setPasteLength] = useState(0);
  // Suppress rapid-fire key events after delete-line-backward (Cmd+Backspace
  // in non-Kitty terminals sends multiple raw bytes parsed as separate events)
  const suppressUntilRef = useRef(0);
  const latestInputSequenceRef = useLatestInputSequence();
  const { stdin } = useStdin();

  const atomList = atoms ?? NO_ATOMS;
  const cursorIndex = snapCaretOutOfAtoms(
    atomList,
    Math.min(rawCursorIndex, value.length),
    'backward',
  );
  const valueRef = useRef(value);
  const propValueRef = useRef(value);
  const cursorRef = useRef(cursorIndex);
  if (propValueRef.current !== value) {
    propValueRef.current = value;
    if (valueRef.current !== value) valueRef.current = value;
  }

  useEffect(() => {
    onCursorChange?.(cursorIndex);
  }, [cursorIndex]);

  // One door out of every editing branch: the branch proposes a string, this turns it back into the
  // range it really changed, grows that range over any atom it touched, and reports both.
  const commit = (nextValue: string, nextCursor: number) => {
    const currentValue = valueRef.current;
    const currentCursor = cursorRef.current;
    const edit = expandEditOverAtoms(
      atomList,
      resolveInputEdit(currentValue, nextValue, nextCursor),
    );
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
    setPasteLength(0);
    onChange(merged, edit);
  };

  const moveCaret = (index: number, prefer: 'backward' | 'forward') => {
    const nextCursorIndex = snapCaretOutOfAtoms(atomList, index, prefer);
    cursorRef.current = nextCursorIndex;
    setCursorIndex(nextCursorIndex);
    setPasteLength(0);
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
      setPasteLength(normalized.length);
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

    const editKey =
      latestInputSequenceRef.current === RAW_BACKSPACE && key.delete && !key.backspace
        ? { ...key, backspace: true, delete: false }
        : key;
    const action = resolveEditAction(input, editKey);
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
      if (onBoundaryNavigate?.('up')) {
        setPasteLength(0);
      }
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
      if (onBoundaryNavigate?.('down')) {
        setPasteLength(0);
      }
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
        setPasteLength(normalized.length > 1 ? normalized.length : 0);
      }
    }
  };

  useInput(handleInput, { isActive });

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
      columns={columns}
      showCursor={showCursor}
      focus={focus}
    />
  );
}
