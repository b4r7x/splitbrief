import wrapAnsi from 'wrap-ansi';

export interface EditResult {
  value: string;
  cursor: number;
}

export type EditAction =
  | 'delete-word-backward'
  | 'delete-word-forward'
  | 'delete-line-backward'
  | 'delete-line-forward'
  | 'move-line-start'
  | 'move-line-end'
  | null;

export function deleteWordBackward(value: string, cursor: number): EditResult {
  if (cursor === 0) return { value, cursor };

  let i = cursor;
  while (i > 0 && value[i - 1] === ' ') i--;
  while (i > 0 && value[i - 1] !== ' ' && value[i - 1] !== '\n') i--;

  return {
    value: value.slice(0, i) + value.slice(cursor),
    cursor: i,
  };
}

export function deleteWordForward(value: string, cursor: number): EditResult {
  if (cursor >= value.length) return { value, cursor };
  let i = cursor;
  while (i < value.length && value[i] !== ' ' && value[i] !== '\n') i++;
  while (i < value.length && value[i] === ' ') i++;
  return {
    value: value.slice(0, cursor) + value.slice(i),
    cursor,
  };
}

export function findVisualLineStart(value: string, cursor: number, columns: number): number {
  const logicalStart = value.lastIndexOf('\n', cursor - 1) + 1;
  const nextNewline = value.indexOf('\n', logicalStart);
  const logicalEnd = nextNewline === -1 ? value.length : nextNewline;
  const logicalLine = value.slice(logicalStart, logicalEnd);
  const cursorInLine = cursor - logicalStart;

  // Insert cursor space to match Ink rendering (ControlledMultilineInput injects
  // ' ' at cursor position; Ink squashes all segments then wraps the combined text)
  const lineWithCursor = logicalLine.slice(0, cursorInLine) + ' ' + logicalLine.slice(cursorInLine);

  const wrapped = wrapAnsi(lineWithCursor, columns, { trim: false, hard: true });
  const visualLines = wrapped.split('\n');

  let offset = 0;
  for (let i = 0; i < visualLines.length; i++) {
    const lineLen = visualLines[i]!.length;
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

export function deleteLineBackward(value: string, cursor: number, columns?: number): EditResult {
  const nfc = toNfc(value, cursor);
  const lineStart = columns != null && columns > 0
    ? findVisualLineStart(nfc.value, nfc.cursor, columns)
    : nfc.value.lastIndexOf('\n', nfc.cursor - 1) + 1;

  if (nfc.cursor === lineStart) {
    if (nfc.cursor > 0) {
      return {
        value: nfc.value.slice(0, nfc.cursor - 1) + nfc.value.slice(nfc.cursor),
        cursor: nfc.cursor - 1,
      };
    }
    return { value: nfc.value, cursor: nfc.cursor };
  }

  return {
    value: nfc.value.slice(0, lineStart) + nfc.value.slice(nfc.cursor),
    cursor: lineStart,
  };
}

export function deleteLineForward(value: string, cursor: number): EditResult {
  if (cursor >= value.length) return { value, cursor };
  let lineEnd = value.indexOf('\n', cursor);
  if (lineEnd === -1) lineEnd = value.length;
  if (cursor === lineEnd) return { value, cursor };
  return {
    value: value.slice(0, cursor) + value.slice(lineEnd),
    cursor,
  };
}

export function moveToLineStart(value: string, cursor: number, columns?: number): EditResult {
  const nfc = toNfc(value, cursor);
  const lineStart = columns != null && columns > 0
    ? findVisualLineStart(nfc.value, nfc.cursor, columns)
    : nfc.value.lastIndexOf('\n', nfc.cursor - 1) + 1;
  return { value: nfc.value, cursor: lineStart };
}

export function moveToLineEnd(value: string, cursor: number): EditResult {
  let lineEnd = value.indexOf('\n', cursor);
  if (lineEnd === -1) lineEnd = value.length;
  return { value, cursor: lineEnd };
}

export function resolveEditAction(
  input: string,
  key: { ctrl: boolean; meta: boolean; super: boolean; backspace: boolean; delete: boolean },
): EditAction {
  if (key.ctrl && input === 'w') return 'delete-word-backward';
  if (key.ctrl && input === 'u') return 'delete-line-backward';
  if (key.ctrl && input === 'a') return 'move-line-start';
  if (key.ctrl && input === 'e') return 'move-line-end';
  if (key.super && (key.backspace || key.delete)) return 'delete-line-backward';
  if (key.meta && (key.backspace || key.delete)) return 'delete-word-backward';
  if (key.ctrl && (key.backspace || key.delete)) return 'delete-word-backward';
  return null;
}

export function applyEditAction(
  action: EditAction,
  value: string,
  cursor: number,
  columns?: number,
): EditResult | null {
  if (action === null) return null;
  let result: EditResult | null = null;
  if (action === 'delete-word-backward') result = deleteWordBackward(value, cursor);
  else if (action === 'delete-word-forward') result = deleteWordForward(value, cursor);
  else if (action === 'delete-line-backward') result = deleteLineBackward(value, cursor, columns);
  else if (action === 'delete-line-forward') result = deleteLineForward(value, cursor);
  else if (action === 'move-line-start') result = moveToLineStart(value, cursor, columns);
  else if (action === 'move-line-end') result = moveToLineEnd(value, cursor);
  return result;
}
