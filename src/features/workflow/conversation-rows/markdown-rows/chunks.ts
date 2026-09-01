import { markdownLayoutGlyphs } from '../../../../lib/glyphs.js';
import { parseMarkdownBlocks } from '../../../../utils/markdown/block-parser.js';
import {
  TASK_BRIEF_METADATA_KEYS,
  hasTaskBriefMetadataKeys,
  isMarkdownBlockquoteLine as isBlockquoteLine,
  isMarkdownFenceStartLine as isFenceStartLine,
  isMarkdownTableLine as isTableLine,
  isMarkdownYamlContinuationLine as isYamlContinuationLine,
  parseMarkdownYamlKey as parseYamlKey,
} from '../../../../utils/markdown/grammar.js';
import { layoutMarkdown, markdownLayoutTail } from '../../../../utils/markdown/layout.js';
import { repairMarkdownTailChunk } from '../../../../utils/markdown/repair.js';
import type { MarkdownLayoutTail } from '../../../../utils/markdown/types.js';
import {
  delimitedMetadataCandidateAt,
  markdownSourceChunks,
  markdownSourceLines,
} from './source-chunks.js';
import type {
  MarkdownLayoutChunk,
  MarkdownRowsProjectionEntry,
  MarkdownSourceChunk,
  MarkdownSourceLine,
} from './types.js';
import { createMarkdownRowsCacheEntryFromChunks } from './window.js';
import { SPLITBRIEF_IDENTITY } from '../../../../core/identity.js';

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
    previousBlock: lastRenderedTail(reusedChunks),
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
    chunks: createMarkdownLayoutChunks({ ...input, previousBlock: undefined }),
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
  return chunk.metadataOnly;
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
  previousBlock: MarkdownLayoutTail | undefined;
}): MarkdownLayoutChunk[] {
  const sourceChunks = markdownSourceChunks(input.sourceText, input.startOffset);
  // The leading gap keys off rendered output, not source offset: leading blank
  // lines or HTML comments (planner <!-- Q:… --> markers) produce no rows, and the
  // block after them must compare against the last kind that actually rendered.
  let previousBlock = input.previousBlock;
  return sourceChunks.map((chunk, index) => {
    const laidOut = layoutMarkdownSourceChunk({
      chunk,
      width: input.width,
      chunkIndex: input.startChunkIndex + index,
      isTailChunk: index === sourceChunks.length - 1,
      previousBlock,
    });
    previousBlock = markdownLayoutTail(laidOut.rows) ?? previousBlock;
    return laidOut;
  });
}

function lastRenderedTail(chunks: readonly MarkdownLayoutChunk[]): MarkdownLayoutTail | undefined {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const tail = markdownLayoutTail(chunks[index]?.rows ?? []);
    if (tail !== undefined) return tail;
  }
  return undefined;
}

function layoutMarkdownSourceChunk(input: {
  chunk: MarkdownSourceChunk;
  width: number;
  chunkIndex: number;
  isTailChunk: boolean;
  previousBlock: MarkdownLayoutTail | undefined;
}): MarkdownLayoutChunk {
  const laidOut = buildMarkdownLayoutChunk(
    input.chunk,
    input.width,
    input.chunkIndex,
    input.previousBlock,
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
    input.previousBlock,
  );
}

function buildMarkdownLayoutChunk(
  chunk: MarkdownSourceChunk,
  width: number,
  chunkIndex: number,
  previousBlock: MarkdownLayoutTail | undefined,
): MarkdownLayoutChunk {
  const document =
    chunk.startOffset === 0
      ? parseMarkdownBlocks(chunk.text)
      : parseMarkdownContinuationChunk(chunk.text);
  const layout = layoutMarkdown(document, {
    width,
    previousBlock,
    glyphs: markdownLayoutGlyphs(),
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
    metadataOnly:
      document.blocks.length > 0 && document.blocks.every((block) => block.kind === 'frontmatter'),
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
