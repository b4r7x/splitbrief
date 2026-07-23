import { parseMarkdownInlines } from './inline-parser.js';
import { stripTerminalControls } from '../display-text.js';
import type {
  MarkdownCodeBlock,
  MarkdownDocument,
  MarkdownHeadingDepth,
  MarkdownListItem,
  MarkdownBlock,
  MarkdownTableAlignment,
  MarkdownTableCell,
} from './types.js';
import {
  isMarkdownBlockquoteLine as isBlockquoteLine,
  isMarkdownFenceCloseLine as isFenceClose,
  isMarkdownHtmlCommentStartLine as isHtmlCommentStartLine,
  isMarkdownListItemLine as isListItemLine,
  isMarkdownTableLine as isTableLine,
  isMarkdownTableSeparatorLine as isTableSeparatorLine,
  isMarkdownThematicBreakLine as isThematicBreak,
  markdownHtmlCommentEndsOnLine as commentEndsOnLine,
  parseMarkdownFenceStart as parseFenceStart,
  parseMarkdownHeadingStart,
  type MarkdownFenceStart,
} from './grammar.js';
import { parseFrontmatter, parseTaskBriefMetadata } from './frontmatter.js';

interface ParseState {
  lines: readonly string[];
  index: number;
  allowFrontmatter: boolean;
  blockquoteDepth: number;
}

interface ParseLinesOptions {
  lines: readonly string[];
  allowFrontmatter: boolean;
  blockquoteDepth: number;
}

const MAX_BLOCKQUOTE_NESTING = 8;

export function parseMarkdownBlocks(source: string): MarkdownDocument {
  return { blocks: parseDocumentLines(splitLines(source)) };
}

function parseDocumentLines(lines: readonly string[]): MarkdownBlock[] {
  return parseLines({ lines, allowFrontmatter: true, blockquoteDepth: 0 });
}

function parseNestedLines(lines: readonly string[], blockquoteDepth: number): MarkdownBlock[] {
  return parseLines({ lines, allowFrontmatter: false, blockquoteDepth });
}

function parseLines(options: ParseLinesOptions): MarkdownBlock[] {
  const state: ParseState = {
    lines: options.lines,
    index: 0,
    allowFrontmatter: options.allowFrontmatter,
    blockquoteDepth: options.blockquoteDepth,
  };
  const blocks: MarkdownBlock[] = [];

  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line === undefined) break;

    if (line.trim().length === 0) {
      state.index += 1;
      continue;
    }

    const taskBriefMetadata = parseTaskBriefMetadata(state);
    if (taskBriefMetadata) {
      blocks.push(taskBriefMetadata.block);
      state.index = taskBriefMetadata.nextIndex;
      continue;
    }

    if (state.allowFrontmatter && state.index === 0) {
      const frontmatter = parseFrontmatter(state);
      if (frontmatter) {
        blocks.push(frontmatter.block);
        state.index = frontmatter.nextIndex;
        continue;
      }
    }

    const fence = parseFenceStart(line);
    if (fence) {
      blocks.push(parseCodeBlock(state, fence));
      continue;
    }

    const heading = parseHeading(line);
    if (heading) {
      blocks.push(heading);
      state.index += 1;
      continue;
    }

    if (isThematicBreak(line)) {
      blocks.push({ kind: 'thematicBreak' });
      state.index += 1;
      continue;
    }

    if (isTableStart(line, state.lines[state.index + 1])) {
      blocks.push(parseTable(state));
      continue;
    }

    if (isHtmlCommentStartLine(line)) {
      blocks.push(parseHtmlComment(state));
      continue;
    }

    if (isListItemLine(line)) {
      blocks.push(parseList(state));
      continue;
    }

    if (canParseBlockquote(state) && isBlockquoteLine(line)) {
      blocks.push(parseBlockquote(state));
      continue;
    }

    blocks.push(parseParagraph(state));
  }

  return blocks;
}

function splitLines(source: string): string[] {
  return source.replace(/\r\n?/g, '\n').split('\n').map(stripTerminalControls);
}

function parseCodeBlock(state: ParseState, fence: MarkdownFenceStart): MarkdownCodeBlock {
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

function parseHeading(line: string): MarkdownBlock | undefined {
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

function isTableStart(line: string, nextLine: string | undefined): boolean {
  return isTableLine(line) && nextLine !== undefined && isTableSeparatorLine(nextLine);
}

function parseTable(state: ParseState): MarkdownBlock {
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

function parseHtmlComment(state: ParseState): MarkdownBlock {
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

function parseList(state: ParseState): MarkdownBlock {
  const items: MarkdownListItem[] = [];

  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line === undefined || line.trim().length === 0) break;

    const item = parseListItem(line);
    if (!item) break;

    items.push(item);
    state.index += 1;
  }

  return { kind: 'list', items };
}

function parseListItem(line: string): MarkdownListItem | undefined {
  const unordered = /^(\s*)([-*+])\s+(.+)$/.exec(line);
  if (unordered) {
    const indentText = unordered[1];
    const markerText = unordered[2];
    const text = unordered[3];
    const marker = parseUnorderedMarker(markerText);
    if (indentText === undefined || marker === undefined || text === undefined) return undefined;
    return {
      kind: 'unordered',
      indent: indentWidth(indentText),
      marker,
      text,
      inlines: parseMarkdownInlines(text),
    };
  }

  const ordered = /^(\s*)(\d+)([.)])\s+(.+)$/.exec(line);
  if (!ordered) return undefined;

  const indentText = ordered[1];
  const numberText = ordered[2];
  const punctuation = ordered[3];
  const text = ordered[4];
  if (indentText === undefined || !numberText || !punctuation || text === undefined) {
    return undefined;
  }

  const start = Number.parseInt(numberText, 10);
  return {
    kind: 'ordered',
    indent: indentWidth(indentText),
    marker: `${numberText}${punctuation}`,
    start,
    text,
    inlines: parseMarkdownInlines(text),
  };
}

function parseBlockquote(state: ParseState): MarkdownBlock {
  const lines: string[] = [];

  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line === undefined || !isBlockquoteLine(line)) break;

    const match = /^ {0,3}>\s?(.*)$/.exec(line);
    lines.push(match?.[1] ?? '');
    state.index += 1;
  }

  return { kind: 'blockquote', blocks: parseNestedLines(lines, state.blockquoteDepth + 1) };
}

function parseParagraph(state: ParseState): MarkdownBlock {
  const lines: string[] = [];

  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line === undefined || line.trim().length === 0) break;
    if (lines.length > 0 && startsBlock(line, state)) break;

    lines.push(line.trim());
    state.index += 1;

    const next = state.lines[state.index];
    if (next !== undefined && startsBlock(next, state)) break;
  }

  const text = lines.join(' ');
  return {
    kind: 'paragraph',
    text,
    inlines: parseMarkdownInlines(text),
  };
}

// Both parseParagraph call sites test the line sitting at state.index, so the
// table lookahead line is always state.lines[state.index + 1].
function startsBlock(line: string, state: ParseState): boolean {
  return (
    parseFenceStart(line) !== undefined ||
    parseHeading(line) !== undefined ||
    isThematicBreak(line) ||
    isListItemLine(line) ||
    isTableStart(line, state.lines[state.index + 1]) ||
    isHtmlCommentStartLine(line) ||
    (canParseBlockquote(state) && isBlockquoteLine(line))
  );
}

function canParseBlockquote(state: ParseState): boolean {
  return state.blockquoteDepth < MAX_BLOCKQUOTE_NESTING;
}

function parseUnorderedMarker(marker: string | undefined): '-' | '*' | '+' | undefined {
  switch (marker) {
    case '-':
      return '-';
    case '*':
      return '*';
    case '+':
      return '+';
    default:
      return undefined;
  }
}

function indentWidth(indent: string): number {
  return indent.replace(/\t/g, '    ').length;
}
