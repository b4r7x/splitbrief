import {
  type MarkdownFenceStart,
  isMarkdownFenceCloseLine as isFenceClose,
  parseMarkdownHeadingStart,
  isMarkdownTableLine as isTableLine,
  isMarkdownTableSeparatorLine as isTableSeparatorLine,
  markdownHtmlCommentEndsOnLine as commentEndsOnLine,
} from './grammar.js';
import { parseMarkdownInlines } from './inline-parser.js';
import type {
  ParseState,
  MarkdownCodeBlock,
  MarkdownBlock,
  MarkdownHeadingDepth,
  MarkdownTableCell,
  MarkdownTableAlignment,
} from './types.js';

export function parseCodeBlock(state: ParseState, fence: MarkdownFenceStart): MarkdownCodeBlock {
  const lines: string[] = [];
  state.index += 1;

  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line === undefined) break;
    if (isFenceClose(line, fence.marker)) {
      state.index += 1;
      return createCodeBlock(fence.language, lines);
    }
    lines.push(line);
    state.index += 1;
  }

  return createCodeBlock(fence.language, lines);
}

function createCodeBlock(
  language: string | undefined,
  lines: readonly string[],
): MarkdownCodeBlock {
  if (language === undefined) {
    return { kind: 'code', lines };
  }
  return { kind: 'code', language, lines };
}

export function parseHeading(line: string): MarkdownBlock | undefined {
  const parsed = parseMarkdownHeadingStart(line);
  if (!parsed) return undefined;

  const depth = headingDepth(parsed.marker.length);
  if (!depth) return undefined;

  return {
    kind: 'heading',
    depth,
    text: parsed.text,
    inlines: parseMarkdownInlines(parsed.text),
  };
}

function headingDepth(markerLength: number): MarkdownHeadingDepth | undefined {
  switch (markerLength) {
    case 1:
      return 1;
    case 2:
      return 2;
    case 3:
      return 3;
    case 4:
      return 4;
    case 5:
      return 5;
    case 6:
      return 6;
    default:
      return undefined;
  }
}

export function isTableStart(line: string, nextLine: string | undefined): boolean {
  return isTableLine(line) && nextLine !== undefined && isTableSeparatorLine(nextLine);
}

export function parseTable(state: ParseState): MarkdownBlock {
  const header = tableCellsFromLine(state.lines[state.index] ?? '');
  const alignments = tableAlignments(state.lines[state.index + 1] ?? '');
  state.index += 2;

  const rows: MarkdownTableCell[][] = [];
  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line === undefined || !isTableLine(line)) break;
    rows.push(tableCellsFromLine(line));
    state.index += 1;
  }

  return { kind: 'table', alignments, header, rows };
}

function tableCellsFromLine(line: string): MarkdownTableCell[] {
  return splitTableRowCells(line).map((text) => ({ text, inlines: parseMarkdownInlines(text) }));
}

function splitTableRowCells(line: string): string[] {
  const trimmed = line.trim();
  const cells: string[] = [];
  let current = '';

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === '\\' && trimmed[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (char === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);

  if (cells[0]?.trim().length === 0) cells.shift();
  if (cells[cells.length - 1]?.trim().length === 0) cells.pop();
  return cells.map((cell) => cell.trim());
}

function tableAlignments(line: string): MarkdownTableAlignment[] {
  return splitTableRowCells(line).map((cell) => {
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    if (cell.endsWith(':')) return 'right';
    return 'left';
  });
}

export function parseHtmlComment(state: ParseState): MarkdownBlock {
  const lines: string[] = [];

  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line === undefined) break;
    if (!commentEndsOnLine(line)) {
      lines.push(line);
      state.index += 1;
      continue;
    }

    const closeEnd = line.lastIndexOf('-->') + '-->'.length;
    const remainder = line.slice(closeEnd);
    if (remainder.trim().length === 0) {
      lines.push(line);
      state.index += 1;
      break;
    }

    // Text after the final '-->' stays visible (CommonMark): substitute it for
    // the current line without advancing so it re-parses as ordinary content.
    lines.push(line.slice(0, closeEnd));
    const rest = [...state.lines];
    rest[state.index] = remainder;
    state.lines = rest;
    break;
  }

  return { kind: 'htmlComment', lines };
}
