import { parseMarkdownInlines } from './inline-parser.js';
import { stripTerminalControls } from '../display-text.js';
import type {
  MarkdownCodeBlock,
  MarkdownDocument,
  MarkdownHeadingDepth,
  MarkdownListItem,
  MarkdownBlock,
} from './types.js';

interface ParseState {
  lines: readonly string[];
  index: number;
  allowFrontmatter: boolean;
  blockquoteDepth: number;
}

interface FenceStart {
  marker: string;
  language: string | undefined;
}

interface ParseLinesOptions {
  lines: readonly string[];
  allowFrontmatter: boolean;
  blockquoteDepth: number;
}

interface MetadataCandidate {
  lines: string[];
  keys: ReadonlySet<string>;
  nextIndex: number;
}

const REQUIRED_TASK_BRIEF_METADATA_KEYS = ['id', 'title', 'action', 'file', 'depends_on'];
const TASK_BRIEF_METADATA_KEYS = new Set<string>(REQUIRED_TASK_BRIEF_METADATA_KEYS);
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
      blocks.push(taskBriefMetadata);
      continue;
    }

    if (state.allowFrontmatter && state.index === 0) {
      const frontmatter = parseFrontmatter(state);
      if (frontmatter) {
        blocks.push(frontmatter);
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

function parseFrontmatter(state: ParseState): MarkdownBlock | undefined {
  const firstLine = state.lines[state.index];
  if (firstLine === undefined) return undefined;

  if (firstLine.trim() === '---') {
    const lines: string[] = [];
    let cursor = state.index + 1;
    while (cursor < state.lines.length) {
      const line = state.lines[cursor];
      if (line === undefined) break;
      if (line.trim() === '---') {
        state.index = cursor + 1;
        return { kind: 'frontmatter', lines };
      }
      lines.push(line);
      cursor += 1;
    }
    return undefined;
  }

  const yamlLines: string[] = [];
  let cursor = state.index;
  while (cursor < state.lines.length) {
    const line = state.lines[cursor];
    if (line === undefined || line.trim().length === 0) break;
    if (!isYamlLikeLine(line)) break;
    yamlLines.push(line);
    cursor += 1;
  }

  if (yamlLines.length >= 2) {
    state.index = cursor;
    return { kind: 'frontmatter', lines: yamlLines };
  }

  return undefined;
}

function parseTaskBriefMetadata(state: ParseState): MarkdownBlock | undefined {
  const delimited = collectDelimitedYamlMetadata(state);
  if (delimited && hasTaskBriefMetadataKeys(delimited.keys)) {
    state.index = delimited.nextIndex;
    return { kind: 'frontmatter', lines: delimited.lines };
  }

  const bare = collectBareYamlMetadata(state);
  if (!bare || !hasTaskBriefMetadataKeys(bare.keys)) return undefined;

  const closingLine = state.lines[bare.nextIndex];
  state.index = closingLine?.trim() === '---' ? bare.nextIndex + 1 : bare.nextIndex;
  return { kind: 'frontmatter', lines: bare.lines };
}

function collectDelimitedYamlMetadata(state: ParseState): MetadataCandidate | undefined {
  const firstLine = state.lines[state.index];
  if (firstLine?.trim() !== '---') return undefined;

  const lines: string[] = [];
  let cursor = state.index + 1;
  while (cursor < state.lines.length) {
    const line = state.lines[cursor];
    if (line === undefined) break;
    if (line.trim() === '---') {
      return createMetadataCandidate(lines, cursor + 1);
    }
    lines.push(line);
    cursor += 1;
  }

  return undefined;
}

function collectBareYamlMetadata(state: ParseState): MetadataCandidate | undefined {
  const lines: string[] = [];
  let cursor = state.index;
  let hasTopLevelKey = false;

  while (cursor < state.lines.length) {
    const line = state.lines[cursor];
    if (line === undefined || line.trim().length === 0 || line.trim() === '---') break;

    const key = parseYamlKey(line);
    if (key !== undefined) {
      hasTopLevelKey = true;
      lines.push(line);
      cursor += 1;
      continue;
    }

    if (hasTopLevelKey && isYamlContinuationLine(line)) {
      lines.push(line);
      cursor += 1;
      continue;
    }

    break;
  }

  return createMetadataCandidate(lines, cursor);
}

function createMetadataCandidate(
  lines: readonly string[],
  nextIndex: number,
): MetadataCandidate | undefined {
  const keys = new Set<string>();
  let hasTopLevelKey = false;

  for (const line of lines) {
    const key = parseYamlKey(line);
    if (key !== undefined) {
      hasTopLevelKey = true;
      keys.add(key);
      continue;
    }

    if (hasTopLevelKey && isYamlContinuationLine(line)) continue;
    return undefined;
  }

  if (lines.length === 0) return undefined;
  return { lines: [...lines], keys, nextIndex };
}

function hasTaskBriefMetadataKeys(keys: ReadonlySet<string>): boolean {
  for (const key of keys) {
    if (!TASK_BRIEF_METADATA_KEYS.has(key)) return false;
  }

  for (const key of REQUIRED_TASK_BRIEF_METADATA_KEYS) {
    if (!keys.has(key)) return false;
  }

  return true;
}

function parseCodeBlock(state: ParseState, fence: FenceStart): MarkdownCodeBlock {
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
  const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
  const marker = match?.[1];
  const text = match?.[2];
  if (!marker || !text) return undefined;

  const depth = headingDepth(marker.length);
  if (!depth) return undefined;

  return {
    kind: 'heading',
    depth,
    text,
    inlines: parseMarkdownInlines(text),
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
    default:
      return undefined;
  }
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

function startsBlock(line: string, state: ParseState): boolean {
  return (
    parseFenceStart(line) !== undefined ||
    parseHeading(line) !== undefined ||
    isThematicBreak(line) ||
    isListItemLine(line) ||
    (canParseBlockquote(state) && isBlockquoteLine(line))
  );
}

function canParseBlockquote(state: ParseState): boolean {
  return state.blockquoteDepth < MAX_BLOCKQUOTE_NESTING;
}

function parseFenceStart(line: string): FenceStart | undefined {
  const trimmed = trimFenceIndent(line);
  if (trimmed === undefined) return undefined;

  const marker = readFenceMarker(trimmed);
  if (!marker) return undefined;

  const info = trimmed.slice(marker.length).trim();
  const languageMatch = /^\S+/.exec(info);
  return { marker, language: languageMatch?.[0] };
}

function readFenceMarker(trimmed: string): string | undefined {
  const first = trimmed[0];
  if (first !== '`' && first !== '~') return undefined;

  const count = countLeading(trimmed, first);
  if (count < 3) return undefined;

  return first.repeat(count);
}

function isFenceClose(line: string, marker: string): boolean {
  const trimmed = trimFenceIndent(line);
  if (trimmed === undefined) return false;

  const first = marker[0];
  if (first === undefined) return false;

  const count = countLeading(trimmed, first);
  if (count < marker.length) return false;

  return trimmed.slice(count).trim().length === 0;
}

function trimFenceIndent(line: string): string | undefined {
  const trimmed = line.trimStart();
  if (line.length - trimmed.length > 3) return undefined;
  return trimmed;
}

function countLeading(text: string, char: string): number {
  let count = 0;
  while (text[count] === char) {
    count += 1;
  }
  return count;
}

function isThematicBreak(line: string): boolean {
  return /^ {0,3}((?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,})$/.test(line);
}

function isListItemLine(line: string): boolean {
  return /^(\s*)([-*+])\s+.+$/.test(line) || /^(\s*)(\d+)([.)])\s+.+$/.test(line);
}

function isBlockquoteLine(line: string): boolean {
  return /^ {0,3}>\s?.*$/.test(line);
}

function isYamlLikeLine(line: string): boolean {
  return parseYamlKey(line) !== undefined || isYamlContinuationLine(line);
}

function parseYamlKey(line: string): string | undefined {
  const match = /^([A-Za-z0-9_-]+):\s*.*$/.exec(line);
  return match?.[1];
}

function isYamlContinuationLine(line: string): boolean {
  return /^\s{2,}\S.*$/.test(line);
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
