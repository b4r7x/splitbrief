import { parseMarkdownBlocks } from '../../../../utils/markdown/block-parser.js';
import {
  TASK_BRIEF_METADATA_KEYS,
  hasTaskBriefMetadataKeys,
  isMarkdownBlockquoteLine as isBlockquoteLine,
  isMarkdownFenceCloseLine as isFenceCloseLine,
  isMarkdownFenceStartLine as isFenceStartLine,
  isMarkdownHeadingLine as isHeadingLine,
  isMarkdownHtmlCommentStartLine as isHtmlCommentStartLine,
  isMarkdownListItemLine as isListItemLine,
  isMarkdownTableLine as isTableLine,
  isMarkdownTableSeparatorLine as isTableSeparatorLine,
  isMarkdownThematicBreakLine as isThematicBreakLine,
  isMarkdownYamlContinuationLine as isYamlContinuationLine,
  markdownFenceMarker as fenceMarker,
  markdownHtmlCommentEndsOnLine as commentEndsOnLine,
  parseMarkdownYamlKey as parseYamlKey,
} from '../../../../utils/markdown/grammar.js';
import { layoutMarkdown } from '../../../../utils/markdown/layout.js';
import { repairMarkdownTailChunk } from '../../../../utils/markdown/repair.js';
import type {
  MarkdownLayoutChunk,
  MarkdownRowsProjectionEntry,
  MarkdownSourceChunk,
  MarkdownSourceLine,
  MetadataCandidate,
} from './types.js';
import { createMarkdownRowsCacheEntryFromChunks } from './window.js';
import { SPLITBRIEF_IDENTITY } from '../../../../core/identity.js';

const MAX_LIST_LINES_PER_CHUNK = 64;
const CONTINUATION_SENTINEL = `# ${SPLITBRIEF_IDENTITY.slug}-continuation-sentinel`;

export function appendMarkdownRowsCacheEntry(input: {
  cached: MarkdownRowsProjectionEntry;
  sourceText: string;
  keyPrefix: string;
  width: number;
  projectDir: string | undefined;
}): MarkdownRowsProjectionEntry {
  const reuseCount = appendMarkdownRowsReuseCount(input.cached, input.sourceText);
  const reusedChunks = input.cached.chunks.slice(0, reuseCount);
  const tailStart = reusedChunks.at(-1)?.endOffset ?? 0;
  const tailChunks = createMarkdownLayoutChunks({
    sourceText: input.sourceText.slice(tailStart),
    width: input.width,
    startChunkIndex: reuseCount,
    startOffset: tailStart,
    hasRenderedPrefix: reusedChunks.some((chunk) => chunk.rows.length > 0),
  });
  return createMarkdownRowsCacheEntryFromChunks({
    sourceText: input.sourceText,
    keyPrefix: input.keyPrefix,
    chunks: [...reusedChunks, ...tailChunks],
    projectDir: input.projectDir,
  });
}

export function createMarkdownRowsCacheEntry(input: {
  sourceText: string;
  keyPrefix: string;
  width: number;
  startChunkIndex: number;
  startOffset: number;
  projectDir: string | undefined;
}): MarkdownRowsProjectionEntry {
  return createMarkdownRowsCacheEntryFromChunks({
    sourceText: input.sourceText,
    keyPrefix: input.keyPrefix,
    chunks: createMarkdownLayoutChunks({ ...input, hasRenderedPrefix: false }),
    projectDir: input.projectDir,
  });
}

export function normalizeMarkdownSource(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function appendMarkdownRowsReuseCount(
  cached: MarkdownRowsProjectionEntry,
  sourceText: string,
): number {
  const defaultReuseCount = Math.max(0, cached.chunks.length - 1);
  const metadataPrefixOffset = appendSensitiveMetadataPrefixOffset({
    sourceText,
    chunks: cached.chunks,
    defaultReuseCount,
  });
  if (metadataPrefixOffset === undefined) return defaultReuseCount;

  const reuseCount = cached.chunks.findIndex((chunk) => chunk.endOffset > metadataPrefixOffset);
  return reuseCount === -1 ? defaultReuseCount : Math.min(reuseCount, defaultReuseCount);
}

function appendSensitiveMetadataPrefixOffset(input: {
  sourceText: string;
  chunks: readonly MarkdownLayoutChunk[];
  defaultReuseCount: number;
}): number | undefined {
  for (let index = 0; index < input.defaultReuseCount; index += 1) {
    const chunk = input.chunks[index];
    if (chunk === undefined) break;
    if (isMetadataChunk(chunk)) continue;
    if (!chunkStartsWithDelimiter(input.sourceText, chunk)) continue;
    if (isAppendSensitiveMetadataRegion(input.sourceText, chunk.startOffset)) {
      return chunk.startOffset;
    }
  }

  return undefined;
}

function isMetadataChunk(chunk: MarkdownLayoutChunk): boolean {
  return chunk.rows.length > 0 && chunk.rows.every((row) => row.blockKind === 'frontmatter');
}

function chunkStartsWithDelimiter(sourceText: string, chunk: MarkdownLayoutChunk): boolean {
  const text = sourceText.slice(chunk.startOffset, chunk.endOffset);
  const newlineIndex = text.indexOf('\n');
  const firstLine = newlineIndex === -1 ? text : text.slice(0, newlineIndex);
  return firstLine.trim() === '---';
}

function isAppendSensitiveMetadataRegion(sourceText: string, startOffset: number): boolean {
  const lines = markdownSourceLines(sourceText.slice(startOffset), startOffset);
  if (lines[0]?.text.trim() !== '---') return false;

  return startOffset === 0
    ? isInitialFrontmatterCandidateRegion(lines)
    : isTaskBriefMetadataCandidateRegion(lines);
}

function isInitialFrontmatterCandidateRegion(lines: readonly MarkdownSourceLine[]): boolean {
  if (delimitedMetadataCandidateAt(lines, 0) !== undefined) return true;
  return isOpenYamlMetadataPrefix(lines, 'frontmatter');
}

function isTaskBriefMetadataCandidateRegion(lines: readonly MarkdownSourceLine[]): boolean {
  const metadata = delimitedMetadataCandidateAt(lines, 0);
  if (metadata !== undefined) return metadata.validYaml && hasTaskBriefMetadataKeys(metadata.keys);
  return isOpenYamlMetadataPrefix(lines, 'task');
}

function isOpenYamlMetadataPrefix(
  lines: readonly MarkdownSourceLine[],
  kind: 'frontmatter' | 'task',
): boolean {
  let cursor = 1;
  let hasTopLevelKey = false;

  while (cursor < lines.length) {
    const text = lines[cursor]?.text ?? '';
    if (text.trim() === '---') return false;
    if (text.trim().length === 0) {
      if (kind === 'task') return false;
      cursor += 1;
      continue;
    }

    const key = parseYamlKey(text);
    if (key !== undefined) {
      if (kind === 'task' && !TASK_BRIEF_METADATA_KEYS.has(key)) return false;
      hasTopLevelKey = true;
      cursor += 1;
      continue;
    }

    if (hasTopLevelKey && isYamlContinuationLine(text)) {
      cursor += 1;
      continue;
    }

    if (isPotentialYamlKeyPrefix(text, kind)) {
      cursor += 1;
      continue;
    }

    return false;
  }

  return true;
}

function isPotentialYamlKeyPrefix(line: string, kind: 'frontmatter' | 'task'): boolean {
  const match = /^([A-Za-z0-9_-]+)$/.exec(line);
  const prefix = match?.[1];
  if (!prefix) return false;
  if (kind === 'frontmatter') return true;

  for (const key of TASK_BRIEF_METADATA_KEYS) {
    if (key.startsWith(prefix)) return true;
  }

  return false;
}

function createMarkdownLayoutChunks(input: {
  sourceText: string;
  width: number;
  startChunkIndex: number;
  startOffset: number;
  hasRenderedPrefix: boolean;
}): MarkdownLayoutChunk[] {
  const sourceChunks = markdownSourceChunks(input.sourceText, input.startOffset);
  // The heading gap keys off rendered output, not source offset: leading blank
  // lines or HTML comments (planner <!-- Q:… --> markers) produce no rows, and a
  // heading after them must not open the document with a spacer.
  let hasRenderedPrefix = input.hasRenderedPrefix;
  return sourceChunks.map((chunk, index) => {
    const laidOut = layoutMarkdownSourceChunk({
      chunk,
      width: input.width,
      chunkIndex: input.startChunkIndex + index,
      isTailChunk: index === sourceChunks.length - 1,
      leadingHeadingGap: hasRenderedPrefix,
    });
    hasRenderedPrefix ||= laidOut.rows.length > 0;
    return laidOut;
  });
}

function layoutMarkdownSourceChunk(input: {
  chunk: MarkdownSourceChunk;
  width: number;
  chunkIndex: number;
  isTailChunk: boolean;
  leadingHeadingGap: boolean;
}): MarkdownLayoutChunk {
  const laidOut = buildMarkdownLayoutChunk(
    input.chunk,
    input.width,
    input.chunkIndex,
    input.leadingHeadingGap,
  );
  if (!input.isTailChunk) return laidOut;
  const firstLine = firstChunkLine(input.chunk.text);
  // Blockquote/table bodies can hold fence backticks or odd inline backticks that tail repair
  // would "close" with a stray literal backtick, so they skip repair like fence chunks do.
  if (isFenceStartLine(firstLine) || isBlockquoteLine(firstLine) || isTableLine(firstLine)) {
    return laidOut;
  }
  if (isMetadataChunk(laidOut)) return laidOut;

  const repairedText = repairMarkdownTailChunk(input.chunk.text);
  if (repairedText === input.chunk.text) return laidOut;
  return buildMarkdownLayoutChunk(
    { ...input.chunk, text: repairedText },
    input.width,
    input.chunkIndex,
    input.leadingHeadingGap,
  );
}

function buildMarkdownLayoutChunk(
  chunk: MarkdownSourceChunk,
  width: number,
  chunkIndex: number,
  leadingHeadingGap: boolean,
): MarkdownLayoutChunk {
  const document =
    chunk.startOffset === 0
      ? parseMarkdownBlocks(chunk.text)
      : parseMarkdownContinuationChunk(chunk.text);
  const layout = layoutMarkdown(document, {
    width,
    leadingHeadingGap,
  });
  const rows = layout.rows.map((rowValue) => ({
    ...rowValue,
    key: `chunk-${chunkIndex}-${rowValue.key}`,
  }));

  return {
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    rows,
    height: layout.height,
  };
}

function firstChunkLine(text: string): string {
  const newlineIndex = text.indexOf('\n');
  return newlineIndex === -1 ? text : text.slice(0, newlineIndex);
}

function parseMarkdownContinuationChunk(text: string): ReturnType<typeof parseMarkdownBlocks> {
  const parsed = parseMarkdownBlocks(`${CONTINUATION_SENTINEL}\n\n${text}`);
  return { blocks: parsed.blocks.slice(1) };
}

function markdownSourceChunks(sourceText: string, startOffset: number): MarkdownSourceChunk[] {
  const lines = markdownSourceLines(sourceText, startOffset);
  const chunks: MarkdownSourceChunk[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.text.trim().length === 0) {
      index += 1;
      continue;
    }

    const metadata = metadataCandidateAt(lines, index);
    if (metadata && canUseMetadataChunk(line, metadata)) {
      const endIndex = metadata.nextIndex + (metadata.includeClosingLine ? 1 : 0);
      chunks.push(sourceChunkFromLines(sourceText, startOffset, lines, index, endIndex));
      index = endIndex;
      continue;
    }

    if (isFenceStartLine(line.text)) {
      const endIndex = fenceEndIndex(lines, index);
      chunks.push(sourceChunkFromLines(sourceText, startOffset, lines, index, endIndex));
      index = endIndex;
      continue;
    }

    if (isHeadingLine(line.text) || isThematicBreakLine(line.text)) {
      chunks.push(sourceChunkFromLines(sourceText, startOffset, lines, index, index + 1));
      index += 1;
      continue;
    }

    if (isTableLine(line.text) && isTableSeparatorLine(lines[index + 1]?.text ?? '')) {
      const endIndex = tableEndIndex(lines, index);
      chunks.push(sourceChunkFromLines(sourceText, startOffset, lines, index, endIndex));
      index = endIndex;
      continue;
    }

    if (isHtmlCommentStartLine(line.text)) {
      const endIndex = htmlCommentEndIndex(lines, index);
      chunks.push(sourceChunkFromLines(sourceText, startOffset, lines, index, endIndex));
      index = endIndex;
      continue;
    }

    if (isListItemLine(line.text)) {
      const endIndex = listEndIndex(lines, index);
      chunks.push(sourceChunkFromLines(sourceText, startOffset, lines, index, endIndex));
      index = endIndex;
      continue;
    }

    if (isBlockquoteLine(line.text)) {
      const endIndex = blockquoteEndIndex(lines, index);
      chunks.push(sourceChunkFromLines(sourceText, startOffset, lines, index, endIndex));
      index = endIndex;
      continue;
    }

    const endIndex = paragraphEndIndex(lines, index);
    chunks.push(...paragraphSourceChunks(sourceText, startOffset, lines, index, endIndex));
    index = endIndex;
  }

  return chunks;
}

function markdownSourceLines(sourceText: string, startOffset: number): MarkdownSourceLine[] {
  if (sourceText.length === 0) return [];

  const lines: MarkdownSourceLine[] = [];
  let lineStart = 0;

  while (lineStart <= sourceText.length) {
    const newlineIndex = sourceText.indexOf('\n', lineStart);
    if (newlineIndex === -1) {
      lines.push({
        text: sourceText.slice(lineStart),
        startOffset: startOffset + lineStart,
        endOffset: startOffset + sourceText.length,
      });
      break;
    }

    lines.push({
      text: sourceText.slice(lineStart, newlineIndex),
      startOffset: startOffset + lineStart,
      endOffset: startOffset + newlineIndex + 1,
    });
    lineStart = newlineIndex + 1;
  }

  return lines;
}

function sourceChunkFromLines(
  sourceText: string,
  sourceStartOffset: number,
  lines: readonly MarkdownSourceLine[],
  startIndex: number,
  endIndex: number,
): MarkdownSourceChunk {
  const first = lines[startIndex];
  const last = lines[endIndex - 1];
  if (first === undefined || last === undefined) {
    return { text: '', startOffset: sourceStartOffset, endOffset: sourceStartOffset };
  }

  const localStart = first.startOffset - sourceStartOffset;
  const localEnd = last.endOffset - sourceStartOffset;
  return {
    text: sourceText.slice(localStart, localEnd),
    startOffset: first.startOffset,
    endOffset: last.endOffset,
  };
}

function paragraphSourceChunks(
  sourceText: string,
  sourceStartOffset: number,
  lines: readonly MarkdownSourceLine[],
  startIndex: number,
  endIndex: number,
): MarkdownSourceChunk[] {
  return [sourceChunkFromLines(sourceText, sourceStartOffset, lines, startIndex, endIndex)];
}

function metadataCandidateAt(
  lines: readonly MarkdownSourceLine[],
  index: number,
): MetadataCandidate | undefined {
  return delimitedMetadataCandidateAt(lines, index) ?? bareMetadataCandidateAt(lines, index);
}

function delimitedMetadataCandidateAt(
  lines: readonly MarkdownSourceLine[],
  index: number,
): MetadataCandidate | undefined {
  if (lines[index]?.text.trim() !== '---') return undefined;

  const metadataLines: string[] = [];
  let cursor = index + 1;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line === undefined) break;
    if (line.text.trim() === '---') {
      return delimitedMetadataCandidate(metadataLines, cursor);
    }
    metadataLines.push(line.text);
    cursor += 1;
  }

  return undefined;
}

function bareMetadataCandidateAt(
  lines: readonly MarkdownSourceLine[],
  index: number,
): MetadataCandidate | undefined {
  const metadataLines: string[] = [];
  let cursor = index;
  let hasTopLevelKey = false;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line === undefined || line.text.trim().length === 0 || line.text.trim() === '---') break;

    const key = parseYamlKey(line.text);
    if (key !== undefined) {
      hasTopLevelKey = true;
      metadataLines.push(line.text);
      cursor += 1;
      continue;
    }

    if (hasTopLevelKey && isYamlContinuationLine(line.text)) {
      metadataLines.push(line.text);
      cursor += 1;
      continue;
    }

    break;
  }

  const closingLine = lines[cursor];
  return metadataCandidate(metadataLines, cursor, closingLine?.text.trim() === '---');
}

function metadataCandidate(
  lines: readonly string[],
  nextIndex: number,
  includeClosingLine: boolean,
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
  return { keys, nextIndex, includeClosingLine, validYaml: true };
}

function delimitedMetadataCandidate(
  lines: readonly string[],
  nextIndex: number,
): MetadataCandidate | undefined {
  const yaml = metadataCandidate(lines, nextIndex, true);
  if (yaml) return yaml;

  const keys = new Set<string>();
  for (const line of lines) {
    const key = parseYamlKey(line);
    if (key !== undefined) keys.add(key);
  }

  return {
    keys,
    nextIndex,
    includeClosingLine: true,
    validYaml: false,
  };
}

function canUseMetadataChunk(line: MarkdownSourceLine, metadata: MetadataCandidate): boolean {
  return line.startOffset === 0 || (metadata.validYaml && hasTaskBriefMetadataKeys(metadata.keys));
}

function fenceEndIndex(lines: readonly MarkdownSourceLine[], startIndex: number): number {
  const marker = fenceMarker(lines[startIndex]?.text ?? '');
  let cursor = startIndex + 1;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line === undefined) break;
    if (marker !== undefined && isFenceCloseLine(line.text, marker)) return cursor + 1;
    cursor += 1;
  }

  return lines.length;
}

function listEndIndex(lines: readonly MarkdownSourceLine[], startIndex: number): number {
  let cursor = startIndex;
  while (
    cursor < lines.length &&
    cursor - startIndex < MAX_LIST_LINES_PER_CHUNK &&
    isListItemLine(lines[cursor]?.text ?? '')
  ) {
    cursor += 1;
  }
  return cursor;
}

function blockquoteEndIndex(lines: readonly MarkdownSourceLine[], startIndex: number): number {
  let cursor = startIndex;
  while (cursor < lines.length && isBlockquoteLine(lines[cursor]?.text ?? '')) {
    cursor += 1;
  }
  return cursor;
}

function tableEndIndex(lines: readonly MarkdownSourceLine[], startIndex: number): number {
  let cursor = startIndex;
  while (cursor < lines.length && isTableLine(lines[cursor]?.text ?? '')) {
    cursor += 1;
  }
  return cursor;
}

function htmlCommentEndIndex(lines: readonly MarkdownSourceLine[], startIndex: number): number {
  let cursor = startIndex;
  while (cursor < lines.length) {
    const text = lines[cursor]?.text ?? '';
    cursor += 1;
    if (commentEndsOnLine(text)) return cursor;
  }
  return lines.length;
}

function paragraphEndIndex(lines: readonly MarkdownSourceLine[], startIndex: number): number {
  let cursor = startIndex;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line === undefined || line.text.trim().length === 0) break;
    if (cursor > startIndex && startsMarkdownBlock(line.text, lines[cursor + 1]?.text)) break;

    cursor += 1;

    const next = lines[cursor];
    if (next !== undefined && startsMarkdownBlock(next.text, lines[cursor + 1]?.text)) break;
  }

  return cursor;
}

function startsMarkdownBlock(line: string, nextLine: string | undefined): boolean {
  return (
    isFenceStartLine(line) ||
    isHeadingLine(line) ||
    isThematicBreakLine(line) ||
    isListItemLine(line) ||
    isBlockquoteLine(line) ||
    (isTableLine(line) && isTableSeparatorLine(nextLine ?? '')) ||
    isHtmlCommentStartLine(line)
  );
}
