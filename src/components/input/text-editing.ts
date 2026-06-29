import { wrapHard } from '../../utils/wrap.js';
import { normalizeKeySignature } from '../../core/keybindings/normalize.js';
import { resolveTextEditingKeyAction } from '../../core/keybindings/text.js';
import type { TextEditingKeyAction } from '../../core/keybindings/text.js';
import { normalizeLineEndings } from './segments.js';

const RAW_BACKSPACE = '\x7f';

export interface EditResult {
  value: string;
  cursor: number;
}

export function prevCodePointIndex(value: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const before = value.charCodeAt(cursor - 1);
  if (before >= 0xdc00 && before <= 0xdfff && cursor >= 2) {
    const lead = value.charCodeAt(cursor - 2);
    if (lead >= 0xd800 && lead <= 0xdbff) return cursor - 2;
  }
  return cursor - 1;
}

export function nextCodePointIndex(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;
  const at = value.charCodeAt(cursor);
  if (at >= 0xd800 && at <= 0xdbff && cursor + 1 < value.length) {
    const trail = value.charCodeAt(cursor + 1);
    if (trail >= 0xdc00 && trail <= 0xdfff) return cursor + 2;
  }
  return cursor + 1;
}

export function dropLastCodePoint(value: string): string {
  return value.slice(0, prevCodePointIndex(value, value.length));
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

function findVisualLineStart(value: string, cursor: number, columns: number): number {
  const logicalStart = value.lastIndexOf('\n', cursor - 1) + 1;
  const nextNewline = value.indexOf('\n', logicalStart);
  const logicalEnd = nextNewline === -1 ? value.length : nextNewline;
  const logicalLine = value.slice(logicalStart, logicalEnd);
  const cursorInLine = cursor - logicalStart;

  // Insert cursor space to match Ink rendering (segments are squashed then wrapped).
  const lineWithCursor = logicalLine.slice(0, cursorInLine) + ' ' + logicalLine.slice(cursorInLine);

  const visualLines = wrapHard(lineWithCursor, columns).split('\n');

  let offset = 0;
  for (let i = 0; i < visualLines.length; i++) {
    const line = visualLines[i];
    if (line === undefined) continue;
    const lineLen = line.length;
    const isLast = i === visualLines.length - 1;
    if (cursorInLine < offset + lineLen || (isLast && cursorInLine <= offset + lineLen)) {
      break;
    }
    offset += lineLen;
  }

  return logicalStart + offset;
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
      const prev = prevCodePointIndex(nfc.value, nfc.cursor);
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
  return { value, cursor: prevCodePointIndex(value, cursor) };
}

function moveCharForward(value: string, cursor: number): EditResult {
  return { value, cursor: nextCodePointIndex(value, cursor) };
}

function deleteCharBackward(value: string, cursor: number): EditResult {
  if (cursor <= 0) return { value, cursor };
  const prev = prevCodePointIndex(value, cursor);
  return {
    value: value.slice(0, prev) + value.slice(cursor),
    cursor: prev,
  };
}

function deleteCharForward(value: string, cursor: number): EditResult {
  if (cursor >= value.length) return { value, cursor };
  const next = nextCodePointIndex(value, cursor);
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
  const canMove = direction === 'up' ? currentLineIndex > 0 : currentLineIndex < lines.length - 1;
  if (!canMove) return undefined;
  const targetLineIndex = direction === 'up' ? currentLineIndex - 1 : currentLineIndex + 1;
  const targetLine = lines[targetLineIndex];
  if (targetLine === undefined) return undefined;
  const newCol = Math.min(col, targetLine.length);
  let newIndex = 0;
  for (let i = 0; i < targetLineIndex; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    newIndex += line.length + 1;
  }
  return newIndex + newCol;
}
