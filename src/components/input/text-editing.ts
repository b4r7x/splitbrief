import { normalizeKeySignature } from '../../core/keybindings/normalize.js';
import { resolveTextEditingKeyAction } from '../../core/keybindings/text.js';
import type { TextEditingKeyAction } from '../../core/keybindings/text.js';
import {
  displayColumnOfIndex,
  indexAtDisplayColumn,
  nextGraphemeIndex,
  prevGraphemeIndex,
  wrapVisualLines,
  wrapWordVisualLines,
} from '../../core/editor/grapheme-motions.js';
import { normalizeLineEndings, TAB_SIZE } from './segments.js';

const RAW_BACKSPACE = '\x7f';

export interface EditResult {
  value: string;
  cursor: number;
}

export function prevGraphemeBoundary(value: string, cursor: number): number {
  return prevGraphemeIndex(value, cursor);
}

export function nextGraphemeBoundary(value: string, cursor: number): number {
  return nextGraphemeIndex(value, cursor);
}

export function dropLastGrapheme(value: string): string {
  return value.slice(0, prevGraphemeBoundary(value, value.length));
}

export type EditAction = TextEditingKeyAction | null;

function deleteWordBackward(value: string, cursor: number): EditResult {
  if (cursor === 0) return { value, cursor };

  let i = cursor;
  while (i > 0 && value[i - 1] === ' ') i--;
  while (i > 0 && value[i - 1] !== ' ' && value[i - 1] !== '\n') i--;

  return {
    value: value.slice(0, i) + value.slice(cursor),
    cursor: i,
  };
}

// Ctrl+A (move-line-start) and Ctrl+U (delete-line-backward) act on the painted row of the
// caret. The paint wraps the draft with its caret cell and each tab as TAB_SIZE spaces through
// wrapWordVisualLines (controlled-multiline-input.tsx), so this builds the same painted text,
// wraps it the same way and maps the row start back to its offset in `value`. A row that
// starts inside a tab's spaces starts after the tab.
function findVisualLineStart(value: string, cursor: number, columns: number): number {
  let painted = '';
  let caret = 0;
  const valueOffsets: number[] = [];
  for (let i = 0; i <= value.length; i++) {
    if (i === cursor) {
      caret = painted.length;
      painted += ' ';
      valueOffsets.push(i);
    }
    if (i === value.length) break;
    if (value[i] === '\t') {
      painted += ' '.repeat(TAB_SIZE);
      valueOffsets.push(i, ...Array<number>(TAB_SIZE - 1).fill(i + 1));
    } else {
      painted += value[i];
      valueOffsets.push(i);
    }
  }
  const rows = wrapWordVisualLines(painted, columns, caret);
  const rowStart = rows.findLast((row) => row.start <= caret)?.start ?? 0;
  return valueOffsets[rowStart] ?? 0;
}

function toNfc(value: string, cursor: number): { value: string; cursor: number } {
  const nfc = value.normalize('NFC');
  if (nfc === value) return { value, cursor };
  return { value: nfc, cursor: value.slice(0, cursor).normalize('NFC').length };
}

function deleteLineBackward(value: string, cursor: number, columns?: number): EditResult {
  const nfc = toNfc(value, cursor);
  const lineStart =
    columns != null && columns > 0
      ? findVisualLineStart(nfc.value, nfc.cursor, columns)
      : nfc.value.lastIndexOf('\n', nfc.cursor - 1) + 1;

  if (nfc.cursor === lineStart) {
    if (nfc.cursor > 0) {
      const prev = prevGraphemeBoundary(nfc.value, nfc.cursor);
      return {
        value: nfc.value.slice(0, prev) + nfc.value.slice(nfc.cursor),
        cursor: prev,
      };
    }
    return { value: nfc.value, cursor: nfc.cursor };
  }

  return {
    value: nfc.value.slice(0, lineStart) + nfc.value.slice(nfc.cursor),
    cursor: lineStart,
  };
}

function moveToLineStart(value: string, cursor: number, columns?: number): EditResult {
  const nfc = toNfc(value, cursor);
  const lineStart =
    columns != null && columns > 0
      ? findVisualLineStart(nfc.value, nfc.cursor, columns)
      : nfc.value.lastIndexOf('\n', nfc.cursor - 1) + 1;
  return { value: nfc.value, cursor: lineStart };
}

function moveToLineEnd(value: string, cursor: number): EditResult {
  const nfc = toNfc(value, cursor);
  const nextNewline = nfc.value.indexOf('\n', nfc.cursor);
  return { value: nfc.value, cursor: nextNewline === -1 ? nfc.value.length : nextNewline };
}

function moveCharBackward(value: string, cursor: number): EditResult {
  return { value, cursor: prevGraphemeBoundary(value, cursor) };
}

function moveCharForward(value: string, cursor: number): EditResult {
  return { value, cursor: nextGraphemeBoundary(value, cursor) };
}

function deleteCharBackward(value: string, cursor: number): EditResult {
  if (cursor <= 0) return { value, cursor };
  const prev = prevGraphemeBoundary(value, cursor);
  return {
    value: value.slice(0, prev) + value.slice(cursor),
    cursor: prev,
  };
}

function deleteCharForward(value: string, cursor: number): EditResult {
  if (cursor >= value.length) return { value, cursor };
  const next = nextGraphemeBoundary(value, cursor);
  return {
    value: value.slice(0, cursor) + value.slice(next),
    cursor,
  };
}

export function resolveEditAction(
  input: string,
  key: { ctrl: boolean; meta: boolean; super: boolean; backspace: boolean; delete: boolean },
): EditAction {
  const keyForEditing =
    input === RAW_BACKSPACE && !key.backspace ? { ...key, backspace: true } : key;
  return resolveTextEditingKeyAction(normalizeKeySignature({ input, key: keyForEditing }));
}

const editHandlers: Record<
  NonNullable<EditAction>,
  (value: string, cursor: number, columns?: number) => EditResult
> = {
  'delete-word-backward': deleteWordBackward,
  'delete-line-backward': deleteLineBackward,
  'move-line-start': moveToLineStart,
  'move-line-end': moveToLineEnd,
  'move-char-backward': moveCharBackward,
  'move-char-forward': moveCharForward,
  'delete-char-backward': deleteCharBackward,
  'delete-char-forward': deleteCharForward,
};

export interface ApplyEditActionOptions {
  action: EditAction;
  value: string;
  cursor: number;
  columns?: number | undefined;
}

export function applyEditAction({
  action,
  value,
  cursor,
  columns,
}: ApplyEditActionOptions): EditResult | null {
  if (action === null) return null;
  return editHandlers[action](value, cursor, columns);
}

export interface NavigateVerticallyOptions {
  direction: 'up' | 'down';
  value: string;
  cursorIndex: number;
}

export function navigateVertically({
  direction,
  value,
  cursorIndex,
}: NavigateVerticallyOptions): number | undefined {
  const lines = wrapVisualLines(normalizeLineEndings(value), Number.MAX_SAFE_INTEGER);
  let currentLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (cursorIndex >= line.start && cursorIndex <= line.end) {
      currentLineIndex = i;
      break;
    }
  }
  if (currentLineIndex === -1) return undefined;
  const canMove = direction === 'up' ? currentLineIndex > 0 : currentLineIndex < lines.length - 1;
  if (!canMove) return undefined;
  const current = lines[currentLineIndex];
  const target = lines[direction === 'up' ? currentLineIndex - 1 : currentLineIndex + 1];
  if (current === undefined || target === undefined) return undefined;
  const goalCol = displayColumnOfIndex(current.text, cursorIndex - current.start);
  return target.start + indexAtDisplayColumn(target.text, goalCol);
}
