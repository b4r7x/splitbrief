import type { IBufferCell, Terminal } from '@xterm/headless';

export interface SelectionPoint {
  readonly x: number;
  readonly y: number;
}

export interface TerminalFrame {
  readonly cols: number;
  readonly rows: number;
  readonly lines: readonly {
    readonly cells: readonly (IBufferCell | undefined)[];
    readonly isWrapped: boolean;
  }[];
}

/** Call after the terminal's write callback; getCell copies each cell's values. */
export function snapshotTerminalFrame(terminal: Terminal): TerminalFrame {
  const buffer = terminal.buffer.active;
  return {
    cols: terminal.cols,
    rows: terminal.rows,
    lines: Array.from({ length: terminal.rows }, (_, y) => {
      const line = buffer.getLine(buffer.viewportY + y);
      return {
        cells: Array.from({ length: terminal.cols }, (_, x) => line?.getCell(x)),
        isWrapped: line?.isWrapped ?? false,
      };
    }),
  };
}

function selectionRows(frame: TerminalFrame, anchor: SelectionPoint, focus: SelectionPoint) {
  const clamp = (point: SelectionPoint): SelectionPoint => ({
    x: Math.max(0, Math.min(frame.cols - 1, point.x)),
    y: Math.max(0, Math.min(frame.rows - 1, point.y)),
  });
  const a = clamp(anchor);
  const b = clamp(focus);
  const forward = a.y < b.y || (a.y === b.y && a.x <= b.x);
  const start = forward ? a : b;
  const end = forward ? b : a;
  return Array.from({ length: end.y - start.y + 1 }, (_, offset) => {
    const y = start.y + offset;
    const line = frame.lines[y];
    let from = y === start.y ? start.x : 0;
    let to = y === end.y ? end.x + 1 : frame.cols;
    // Both endpoints include the whole glyph when they touch a wide-cell continuation.
    if (from > 0 && line?.cells[from]?.getWidth() === 0) from--;
    if (to < frame.cols && line?.cells[to]?.getWidth() === 0) to++;
    return { y, from, to, line };
  });
}

export function selectionText(
  frame: TerminalFrame,
  anchor: SelectionPoint,
  focus: SelectionPoint,
): string {
  let text = '';
  let firstRow = true;
  for (const { from, to, line } of selectionRows(frame, anchor, focus)) {
    if (!firstRow && !line?.isWrapped) text += '\n';
    firstRow = false;
    let row = '';
    let contentEnd = 0;
    for (let x = from; x < to; x++) {
      const cell = line?.cells[x];
      if (cell?.getWidth() === 0) continue;
      const chars = cell?.getChars() ?? '';
      row += chars || ' ';
      if (chars.length > 0) contentEnd = row.length;
    }
    // Empty terminal cells are padding. Written spaces, including source indentation, survive.
    text += row.slice(0, contentEnd);
  }
  return text;
}

function selectionStyle(cell: IBufferCell | undefined, highlight: boolean): string {
  const codes = [0];
  if (cell) {
    if (cell.isBold()) codes.push(1);
    if (cell.isDim()) codes.push(2);
    if (cell.isItalic()) codes.push(3);
    if (cell.isUnderline()) codes.push(4);
    if (cell.isBlink()) codes.push(5);
    if (cell.isInvisible()) codes.push(8);
    if (cell.isStrikethrough()) codes.push(9);
    if (cell.isOverline()) codes.push(53);
    if (cell.isFgPalette()) codes.push(38, 5, cell.getFgColor());
    if (cell.isBgPalette()) codes.push(48, 5, cell.getBgColor());
    if (cell.isFgRGB()) {
      const rgb = cell.getFgColor();
      codes.push(38, 2, (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
    }
    if (cell.isBgRGB()) {
      const rgb = cell.getBgColor();
      codes.push(48, 2, (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
    }
  }
  const inverse = Boolean(cell?.isInverse());
  codes.push(inverse !== highlight ? 7 : 27);
  return `\u001b[${codes.join(';')}m`;
}

export function renderSelection(
  frame: TerminalFrame,
  anchor: SelectionPoint,
  focus: SelectionPoint,
  previous?: { readonly anchor: SelectionPoint; readonly focus: SelectionPoint },
): string {
  let output = '\u001b7\u001b]8;;\u001b\\';
  const paint = (start: SelectionPoint, end: SelectionPoint, highlight: boolean) => {
    for (const { y, from, to, line } of selectionRows(frame, start, end)) {
      output += `\u001b[${y + 1};${from + 1}H`;
      let lastStyle = '';
      for (let x = from; x < to; x++) {
        const cell = line?.cells[x];
        if (cell?.getWidth() === 0) continue;
        const style = selectionStyle(cell, highlight);
        if (style !== lastStyle) output += style;
        lastStyle = style;
        output += cell?.getChars() || ' ';
      }
    }
  };
  if (previous) paint(previous.anchor, previous.focus, false);
  paint(anchor, focus, true);
  return `${output}\u001b[0m\u001b8`;
}
