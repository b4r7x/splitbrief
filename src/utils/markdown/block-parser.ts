import { parseMarkdownInlines } from './inline-parser.js';
import { stripTerminalControls } from '../display-text/sanitize.js';
import type {
  MarkdownDocument,
  MarkdownListItem,
  MarkdownListItemContinuation,
  MarkdownBlock,
  ParseState,
} from './types.js';
import {
  isMarkdownBlockquoteLine as isBlockquoteLine,
  isMarkdownHtmlCommentStartLine as isHtmlCommentStartLine,
  isMarkdownListContinuationLine as isListContinuationLine,
  isMarkdownListItemLine as isListItemLine,
  isMarkdownThematicBreakLine as isThematicBreak,
  parseMarkdownFenceStart as parseFenceStart,
} from './grammar.js';
import { parseFrontmatter, parseTaskBriefMetadata } from './frontmatter.js';
import {
  parseCodeBlock,
  parseHeading,
  isTableStart,
  parseTable,
  parseHtmlComment,
} from './leaf-blocks.js';

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
  return source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => stripTerminalControls(line));
}

function parseList(state: ParseState): MarkdownBlock {
  const items: MarkdownListItem[] = [];

  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line === undefined || line.trim().length === 0) break;

    const item = parseListItem(line);
    if (!item) break;

    state.index += 1;
    const continuation = parseListItemContinuation(state);
    items.push(continuation === undefined ? item : { ...item, continuation });
  }

  return { kind: 'list', items };
}

function parseListItemContinuation(state: ParseState): MarkdownListItemContinuation | undefined {
  const lines: string[] = [];

  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line === undefined) break;
    if (!isListContinuationLine(line, state.lines[state.index + 1])) break;
    lines.push(line.trim());
    state.index += 1;
  }

  if (lines.length === 0) return undefined;
  const text = lines.join(' ');
  return { text, inlines: parseMarkdownInlines(text) };
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
