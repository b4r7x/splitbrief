import { wrapHard } from '../../utils/wrap.js';
import { normalizeKeySignature } from '../../core/keybindings/normalize.js';
import { resolveTextEditingKeyAction } from '../../core/keybindings/text.js';
import type { TextEditingKeyAction } from '../../core/keybindings/text.js';
import {
  displayColumnOfIndex,
  indexAtDisplayColumn,
  nextGraphemeIndex,
  prevGraphemeIndex,
  wrapVisualLines,
} from '../../core/editor/grapheme-motions.js';
import { normalizeLineEndings } from './segments.js';

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

// Ctrl+A (move-line-start) and Ctrl+U (delete-line-backward) act on VISUAL rows,
// so this must match how Ink actually paints the composer: Ink auto-wraps <Text>
// with wrap-ansi WORD-wrap (controlled-multiline-input.tsx), not the grapheme
// char-wrap in wrapVisualLines. On the composer, wrap-ansi IS the painted-column
// oracle, so re-pointing this at wrapVisualLines would desync the caret from the
// rendered rows on wrapped multi-word lines (e.g. "abc defghijk" @10 breaks at the
// space, not mid-word). The single-width-fn rule (CON-F) applies to the editor
// surfaces that pre-wrap with wrapVisualLines; the Ink-auto-wrapped composer must
// keep wrap-ansi here. Offsets stay in UTF-16 code units to match wrap-ansi output.
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
