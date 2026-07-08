import { getTerminalCellWidth } from '../../utils/display-text.js';

export interface VisualLine {
  start: number;
  end: number;
  text: string;
  width: number;
}

export type EditorAffinity = 'upstream' | 'downstream';

const clusterSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function prevGraphemeIndex(value: string, index: number): number {
  if (index <= 0) return 0;
  const clamped = Math.min(index, value.length);
  let prev = 0;
  for (const seg of clusterSegmenter.segment(value)) {
    if (seg.index >= clamped) break;
    prev = seg.index;
  }
  return prev;
}

export function nextGraphemeIndex(value: string, index: number): number {
  if (index >= value.length) return value.length;
  const clamped = Math.max(index, 0);
  for (const seg of clusterSegmenter.segment(value)) {
    if (seg.index > clamped) return seg.index;
  }
  return value.length;
}

export function displayColumnOfIndex(line: string, index: number): number {
  const clamped = Math.max(0, Math.min(index, line.length));
  return getTerminalCellWidth(line.slice(0, clamped));
}

export function indexAtDisplayColumn(line: string, col: number): number {
  if (col <= 0) return 0;
  let width = 0;
  for (const seg of clusterSegmenter.segment(line)) {
    const graphemeWidth = getTerminalCellWidth(seg.segment);
    if (width + graphemeWidth > col) return seg.index;
    width += graphemeWidth;
  }
  return line.length;
}

export function wrapVisualLines(value: string, columns: number): VisualLine[] {
  const cols = columns > 0 ? columns : 1;
  const lines: VisualLine[] = [];
  let lineStart = 0;
  while (true) {
    const newline = value.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? value.length : newline;
    wrapLogicalLine(value, lineStart, lineEnd, cols, lines);
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return lines;
}

function wrapLogicalLine(
  value: string,
  lineStart: number,
  lineEnd: number,
  cols: number,
  out: VisualLine[],
): void {
  const text = value.slice(lineStart, lineEnd);
  let rowStart = lineStart;
  let rowWidth = 0;
  let abs = lineStart;
  let started = false;
  for (const seg of clusterSegmenter.segment(text)) {
    const graphemeWidth = getTerminalCellWidth(seg.segment);
    if (started && rowWidth + graphemeWidth > cols) {
      out.push({ start: rowStart, end: abs, text: value.slice(rowStart, abs), width: rowWidth });
      rowStart = abs;
      rowWidth = 0;
    }
    rowWidth += graphemeWidth;
    abs += seg.segment.length;
    started = true;
  }
  out.push({
    start: rowStart,
    end: lineEnd,
    text: value.slice(rowStart, lineEnd),
    width: rowWidth,
  });
}

export function visualPositionOf(
  lines: VisualLine[],
  cursor: number,
  affinity: EditorAffinity = 'upstream',
): { row: number; col: number } {
  if (lines.length === 0) return { row: 0, col: 0 };
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    if (line === undefined) continue;
    if (cursor >= line.start && cursor <= line.end) {
      if (affinity === 'downstream' && cursor === line.end && lines[row + 1]?.start === cursor) {
        continue; // soft-wrap seam → attribute to the LOWER row's col 0, not this row's end
      }
      return { row, col: displayColumnOfIndex(line.text, cursor - line.start) };
    }
  }
  const lastRow = lines.length - 1;
  const last = lines[lastRow];
  if (last === undefined) return { row: 0, col: 0 };
  return { row: lastRow, col: displayColumnOfIndex(last.text, last.end - last.start) };
}

export function isSoftWrapSeam(lines: VisualLine[], cursor: number): boolean {
  return lines.some((l, r) => l.end === cursor && lines[r + 1]?.start === cursor);
}

function isInlineSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

export function wordBoundaryBackward(value: string, index: number): number {
  let i = Math.max(0, Math.min(index, value.length));
  while (i > 0 && isInlineSpace(value[i - 1])) i--;
  while (i > 0 && !isInlineSpace(value[i - 1]) && value[i - 1] !== '\n') i--;
  return i;
}

export function wordBoundaryForward(value: string, index: number): number {
  const len = value.length;
  let i = Math.max(0, Math.min(index, len));
  while (i < len && isInlineSpace(value[i])) i++;
  while (i < len && !isInlineSpace(value[i]) && value[i] !== '\n') i++;
  return i;
}
