import {
  hasTaskBriefMetadataKeys,
  isMarkdownBlockquoteLine as isBlockquoteLine,
  isMarkdownFenceCloseLine as isFenceCloseLine,
  isMarkdownFenceStartLine as isFenceStartLine,
  isMarkdownHeadingLine as isHeadingLine,
  isMarkdownHtmlCommentStartLine as isHtmlCommentStartLine,
  isMarkdownListContinuationLine as isListContinuationLine,
  isMarkdownListItemLine as isListItemLine,
  isMarkdownTableLine as isTableLine,
  isMarkdownTableSeparatorLine as isTableSeparatorLine,
  isMarkdownThematicBreakLine as isThematicBreakLine,
  isMarkdownYamlContinuationLine as isYamlContinuationLine,
  markdownFenceMarker as fenceMarker,
  markdownHtmlCommentEndsOnLine as commentEndsOnLine,
  parseMarkdownYamlKey as parseYamlKey,
  startsMarkdownBlockLine as startsMarkdownBlock,
} from '../../../../utils/markdown/grammar.js';
import type { MarkdownSourceChunk, MarkdownSourceLine, MetadataCandidate } from './types.js';

const MAX_LIST_LINES_PER_CHUNK = 64;

export function markdownSourceChunks(
  sourceText: string,
  startOffset: number,
): MarkdownSourceChunk[] {
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
    chunks.push(sourceChunkFromLines(sourceText, startOffset, lines, index, endIndex));
    index = endIndex;
  }

  return chunks;
}

export function markdownSourceLines(sourceText: string, startOffset: number): MarkdownSourceLine[] {
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

function metadataCandidateAt(
  lines: readonly MarkdownSourceLine[],
  index: number,
): MetadataCandidate | undefined {
  return delimitedMetadataCandidateAt(lines, index) ?? bareMetadataCandidateAt(lines, index);
}

export function delimitedMetadataCandidateAt(
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

// The cap is tested only at item lines, so a chunk boundary never falls between a bullet and
// the paragraph that continues it — splitting there would leave the continuation to parse as a
// standalone paragraph and the streamed rows would stop matching a cold render.
function listEndIndex(lines: readonly MarkdownSourceLine[], startIndex: number): number {
  let cursor = startIndex;
  while (cursor < lines.length) {
    const text = lines[cursor]?.text ?? '';
    if (isListItemLine(text)) {
      if (cursor - startIndex >= MAX_LIST_LINES_PER_CHUNK) break;
      cursor += 1;
      continue;
    }
    if (cursor > startIndex && isListContinuationLine(text, lines[cursor + 1]?.text)) {
      cursor += 1;
      continue;
    }
    break;
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
