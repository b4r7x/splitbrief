import type {
  MarkdownRenderSegment,
  MarkdownSegmentDecorator,
} from '../../../components/markdown.js';
import type { Theme } from '../../../components/theme.js';
import { TaskIdSchema } from '../../../core/schemas/task.js';
import { stripTerminalControls } from '../../../utils/display-text.js';
import { parseMarkdownBlocks } from '../../../utils/markdown/block-parser.js';
import {
  TASK_BRIEF_METADATA_KEYS,
  hasTaskBriefMetadataKeys,
  isMarkdownBlockquoteLine as isBlockquoteLine,
  isMarkdownFenceCloseLine as isFenceCloseLine,
  isMarkdownFenceStartLine as isFenceStartLine,
  isMarkdownHeadingLine as isHeadingLine,
  isMarkdownListItemLine as isListItemLine,
  isMarkdownThematicBreakLine as isThematicBreakLine,
  isMarkdownYamlContinuationLine as isYamlContinuationLine,
  markdownFenceMarker as fenceMarker,
  parseMarkdownYamlKey as parseYamlKey,
} from '../../../utils/markdown/grammar.js';
import { layoutMarkdown } from '../../../utils/markdown/layout.js';
import type {
  MarkdownLayoutLine,
  MarkdownLayoutRow,
  MarkdownLayoutSegment,
} from '../../../utils/markdown/types.js';
import { assertNever } from '../../../utils/type-guards.js';
import { sanitizeRowDisplayText } from './row-format.js';
import type { ConversationRow, ConversationRowSegment } from './types.js';

interface MarkdownConversationRowsInput {
  keyPrefix: string;
  text: string;
  width: number;
}

interface MarkdownConversationRowsIdentityInput {
  keyPrefix: string;
  width: number;
}

export interface MarkdownConversationRowsProjection {
  rowCount: number;
  createRows: (windowStart: number, windowEnd: number) => ConversationRow[];
}

type WorkflowMarkdownMarkerKind = 'taskId' | 'filePath' | 'status' | 'risk';

type WorkflowMarkdownPart =
  | { kind: 'base'; segment: MarkdownLayoutSegment }
  | { kind: WorkflowMarkdownMarkerKind; text: string };

interface MarkdownRowsCacheEntry {
  sourceText: string;
  chunks: readonly MarkdownLayoutChunk[];
  projection: MarkdownConversationRowsProjection;
}

interface ActiveMarkdownRowsProjectionKeys {
  ordered: readonly string[];
  set: ReadonlySet<string>;
  ranks: ReadonlyMap<string, number>;
}

interface MarkdownSourceLine {
  text: string;
  startOffset: number;
  endOffset: number;
}

interface MarkdownSourceChunk {
  text: string;
  startOffset: number;
  endOffset: number;
}

interface MarkdownLayoutChunk {
  startOffset: number;
  endOffset: number;
  rows: readonly MarkdownLayoutRow[];
  height: number;
}

interface MetadataCandidate {
  keys: ReadonlySet<string>;
  nextIndex: number;
  includeClosingLine: boolean;
  validYaml: boolean;
}

interface WorkflowMarkerMatch {
  kind: WorkflowMarkdownMarkerKind;
  text: string;
}

const STATUS_MARKERS: readonly string[] = [
  'NOT VERIFIED',
  'INCONCLUSIVE',
  'VERIFIED',
  'BLOCKED',
  'FAILED',
  'FAIL',
  'ERROR',
  'WARN',
  'WARNING',
  'DONE',
  'PASS',
  'OK',
];

const PROSE_STATUS_MARKERS: readonly string[] = [
  'NOT VERIFIED',
  'INCONCLUSIVE',
  'VERIFIED',
  'BLOCKED',
  'FAILED',
];

const RISK_MARKERS: readonly string[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
export const STATUS_DIM_ERROR = '#a85561';
const STATUS_DIM_SUCCESS = '#6e8f4a';
const TASK_ID_PATTERN = /^T\d{3}/;
const FILE_PATH_PATTERN =
  /^(?:\.{1,2}\/|\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.[A-Za-z0-9]+(?::\d+)?/;
const MAX_MARKDOWN_ROW_CACHE_ENTRIES = 24;
const MAX_LIST_LINES_PER_CHUNK = 64;
const CONTINUATION_SENTINEL = '# diptych-continuation-sentinel';

const markdownRowsCache = new Map<string, MarkdownRowsCacheEntry>();
let activeMarkdownRowsProjectionKeys: ActiveMarkdownRowsProjectionKeys | null = null;

export function markdownConversationRows(input: MarkdownConversationRowsInput): ConversationRow[] {
  const projection = markdownConversationRowsProjection(input);
  return projection.createRows(0, projection.rowCount);
}

export function markdownConversationRowsProjection(
  input: MarkdownConversationRowsInput,
): MarkdownConversationRowsProjection {
  const key = markdownRowsIdentityKey(input);
  const sourceText = normalizeMarkdownSource(sanitizeRowDisplayText(input.text));
  const cached = markdownRowsCache.get(key);
  if (cached?.sourceText === sourceText) {
    rememberMarkdownRows(key, cached);
    return cached.projection;
  }

  const next =
    cached !== undefined && sourceText.startsWith(cached.sourceText)
      ? appendMarkdownRowsCacheEntry({
          cached,
          sourceText,
          keyPrefix: input.keyPrefix,
          width: input.width,
        })
      : createMarkdownRowsCacheEntry({
          sourceText,
          keyPrefix: input.keyPrefix,
          width: input.width,
          startChunkIndex: 0,
          startOffset: 0,
        });

  rememberMarkdownRows(key, next);
  return next.projection;
}

export function resetMarkdownConversationRowsCache(): void {
  markdownRowsCache.clear();
}

export function markdownConversationRowsCacheKey(
  input: MarkdownConversationRowsIdentityInput,
): string {
  return markdownRowsIdentityKey(input);
}

export function beginMarkdownConversationRowsProjectionPass(
  activeKeys: Iterable<string>,
): () => void {
  const previous = activeMarkdownRowsProjectionKeys;
  const ordered = [...(previous?.ordered ?? [])];
  const set = new Set(previous?.set ?? []);
  for (const key of activeKeys) {
    if (set.has(key)) continue;
    set.add(key);
    ordered.push(key);
  }
  activeMarkdownRowsProjectionKeys = {
    ordered,
    set,
    ranks: markdownRowsProjectionKeyRanks(ordered),
  };
  return () => {
    activeMarkdownRowsProjectionKeys = previous;
  };
}

function markdownRowsIdentityKey(input: MarkdownConversationRowsIdentityInput): string {
  return [input.keyPrefix, input.width].join('\u0001');
}

function rememberMarkdownRows(key: string, entry: MarkdownRowsCacheEntry): void {
  if (markdownRowsCache.has(key)) markdownRowsCache.delete(key);
  markdownRowsCache.set(key, entry);
  trimMarkdownRowsCache(key);
}

function trimMarkdownRowsCache(insertedKey: string): void {
  while (markdownRowsCache.size > MAX_MARKDOWN_ROW_CACHE_ENTRIES) {
    const oldest =
      oldestEvictableMarkdownRowsKey() ??
      oldestActiveMarkdownRowsKey() ??
      oldestMarkdownRowsKeyExcept(insertedKey) ??
      insertedKey;
    markdownRowsCache.delete(oldest);
  }
}

function oldestEvictableMarkdownRowsKey(): string | undefined {
  for (const key of markdownRowsCache.keys()) {
    if (activeMarkdownRowsProjectionKeys?.set.has(key)) continue;
    return key;
  }
  return undefined;
}

function oldestActiveMarkdownRowsKey(): string | undefined {
  const active = activeMarkdownRowsProjectionKeys;
  if (active === null) return undefined;

  let oldestKey: string | undefined;
  let oldestRank = Number.POSITIVE_INFINITY;
  for (const key of markdownRowsCache.keys()) {
    const rank = active.ranks.get(key);
    if (rank === undefined || rank >= oldestRank) continue;
    oldestRank = rank;
    oldestKey = key;
  }
  return oldestKey;
}

function oldestMarkdownRowsKeyExcept(retainedKey: string): string | undefined {
  for (const key of markdownRowsCache.keys()) {
    if (key !== retainedKey) return key;
  }
  return undefined;
}

function markdownRowsProjectionKeyRanks(keys: readonly string[]): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  for (const [rank, key] of keys.entries()) ranks.set(key, rank);
  return ranks;
}

function appendMarkdownRowsCacheEntry(input: {
  cached: MarkdownRowsCacheEntry;
  sourceText: string;
  keyPrefix: string;
  width: number;
}): MarkdownRowsCacheEntry {
  const reuseCount = appendMarkdownRowsReuseCount(input.cached, input.sourceText);
  const reusedChunks = input.cached.chunks.slice(0, reuseCount);
  const tailStart = reusedChunks.at(-1)?.endOffset ?? 0;
  const tailChunks = createMarkdownLayoutChunks({
    sourceText: input.sourceText.slice(tailStart),
    width: input.width,
    startChunkIndex: reuseCount,
    startOffset: tailStart,
  });
  return createMarkdownRowsCacheEntryFromChunks({
    sourceText: input.sourceText,
    keyPrefix: input.keyPrefix,
    chunks: [...reusedChunks, ...tailChunks],
  });
}

function appendMarkdownRowsReuseCount(cached: MarkdownRowsCacheEntry, sourceText: string): number {
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

function createMarkdownRowsCacheEntry(input: {
  sourceText: string;
  keyPrefix: string;
  width: number;
  startChunkIndex: number;
  startOffset: number;
}): MarkdownRowsCacheEntry {
  return createMarkdownRowsCacheEntryFromChunks({
    sourceText: input.sourceText,
    keyPrefix: input.keyPrefix,
    chunks: createMarkdownLayoutChunks(input),
  });
}

function createMarkdownRowsCacheEntryFromChunks(input: {
  sourceText: string;
  keyPrefix: string;
  chunks: readonly MarkdownLayoutChunk[];
}): MarkdownRowsCacheEntry {
  const rows = input.chunks.flatMap((chunk) => chunk.rows);
  const rowCount = input.chunks.reduce((sum, chunk) => sum + chunk.height, 0);
  const keyPrefix = input.keyPrefix;
  const projection: MarkdownConversationRowsProjection = {
    rowCount,
    createRows: (windowStart, windowEnd) =>
      markdownLayoutWindowRows({
        keyPrefix,
        rows,
        windowStart,
        windowEnd,
      }),
  };

  return {
    sourceText: input.sourceText,
    chunks: input.chunks,
    projection,
  };
}

function createMarkdownLayoutChunks(input: {
  sourceText: string;
  width: number;
  startChunkIndex: number;
  startOffset: number;
}): MarkdownLayoutChunk[] {
  return markdownSourceChunks(input.sourceText, input.startOffset).map((chunk, index) =>
    layoutMarkdownSourceChunk({
      chunk,
      width: input.width,
      chunkIndex: input.startChunkIndex + index,
    }),
  );
}

function layoutMarkdownSourceChunk(input: {
  chunk: MarkdownSourceChunk;
  width: number;
  chunkIndex: number;
}): MarkdownLayoutChunk {
  const document =
    input.chunk.startOffset === 0
      ? parseMarkdownBlocks(input.chunk.text)
      : parseMarkdownContinuationChunk(input.chunk.text);
  const layout = layoutMarkdown(document, { width: input.width });
  const rows = layout.rows.map((rowValue) => ({
    ...rowValue,
    key: `chunk-${input.chunkIndex}-${rowValue.key}`,
  }));

  return {
    startOffset: input.chunk.startOffset,
    endOffset: input.chunk.endOffset,
    rows,
    height: layout.height,
  };
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

function paragraphEndIndex(lines: readonly MarkdownSourceLine[], startIndex: number): number {
  let cursor = startIndex;

  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line === undefined || line.text.trim().length === 0) break;
    if (cursor > startIndex && startsMarkdownBlock(line.text)) break;

    cursor += 1;

    const next = lines[cursor];
    if (next !== undefined && startsMarkdownBlock(next.text)) break;
  }

  return cursor;
}

function startsMarkdownBlock(line: string): boolean {
  return (
    isFenceStartLine(line) ||
    isHeadingLine(line) ||
    isThematicBreakLine(line) ||
    isListItemLine(line) ||
    isBlockquoteLine(line)
  );
}

function normalizeMarkdownSource(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function markdownLayoutWindowRows(input: {
  keyPrefix: string;
  rows: readonly MarkdownLayoutRow[];
  windowStart: number;
  windowEnd: number;
}): ConversationRow[] {
  const rows: ConversationRow[] = [];
  const start = Math.max(0, input.windowStart);
  const end = Math.max(start, input.windowEnd);
  let lineIndex = 0;

  for (const layoutRow of input.rows) {
    const rowStart = lineIndex;
    const rowEnd = rowStart + layoutRow.lines.length;
    lineIndex = rowEnd;
    if (rowEnd <= start) continue;
    if (rowStart >= end) break;

    for (const [localIndex, line] of layoutRow.lines.entries()) {
      const currentIndex = rowStart + localIndex;
      if (currentIndex < start) continue;
      if (currentIndex >= end) break;
      rows.push({
        key: `${input.keyPrefix}-${layoutRow.key}-${currentIndex}`,
        kind: 'message',
        segments: markdownLineSegments(line),
      });
    }
  }

  return rows;
}

function markdownLineSegments(line: MarkdownLayoutLine): ConversationRowSegment[] {
  return line.segments.flatMap((segment) =>
    workflowMarkdownParts(segment).map(workflowMarkdownPartToConversationSegment),
  );
}

export const workflowMarkdownRenderSegments: MarkdownSegmentDecorator = ({
  segment,
  theme,
}: {
  segment: MarkdownLayoutSegment;
  theme: Theme;
}) =>
  workflowMarkdownParts(segment, PROSE_STATUS_MARKERS).map((part) =>
    workflowMarkdownPartToRenderSegment(part, theme),
  );

function workflowMarkdownParts(
  segment: MarkdownLayoutSegment,
  statusMarkers: readonly string[] = STATUS_MARKERS,
): WorkflowMarkdownPart[] {
  const cleanSegment = cloneSegmentWithText(segment, stripTerminalControls(segment.text));
  if (!isWorkflowScannableSegment(cleanSegment)) return [{ kind: 'base', segment: cleanSegment }];

  const parts: WorkflowMarkdownPart[] = [];
  let buffer = '';
  let index = 0;

  while (index < cleanSegment.text.length) {
    const marker = matchWorkflowMarkerAt(cleanSegment.text, index, statusMarkers);
    if (!marker) {
      buffer += cleanSegment.text[index] ?? '';
      index += 1;
      continue;
    }

    if (buffer.length > 0) {
      parts.push({ kind: 'base', segment: cloneSegmentWithText(cleanSegment, buffer) });
      buffer = '';
    }

    parts.push(marker);
    index += marker.text.length;
  }

  if (buffer.length > 0) {
    parts.push({ kind: 'base', segment: cloneSegmentWithText(cleanSegment, buffer) });
  }

  return parts;
}

function cloneSegmentWithText(segment: MarkdownLayoutSegment, text: string): MarkdownLayoutSegment {
  return { kind: segment.kind, text };
}

function isWorkflowScannableSegment(segment: MarkdownLayoutSegment): boolean {
  switch (segment.kind) {
    case 'text':
    case 'heading':
    case 'metadata':
    case 'bold':
    case 'italic':
    case 'boldItalic':
      return true;
    case 'code':
    case 'rule':
    case 'listMarker':
    case 'blockquoteMarker':
      return false;
    default:
      return assertNever(segment.kind);
  }
}

function matchWorkflowMarkerAt(
  text: string,
  index: number,
  statusMarkers: readonly string[],
): WorkflowMarkerMatch | undefined {
  const task = matchPatternAt(text, index, TASK_ID_PATTERN);
  if (task && hasWordBoundary(text, index, task.length) && TaskIdSchema.safeParse(task).success) {
    return { kind: 'taskId', text: task };
  }

  const path = matchPatternAt(text, index, FILE_PATH_PATTERN);
  if (path && hasWordBoundary(text, index, path.length)) {
    return { kind: 'filePath', text: path };
  }

  const status = matchKeywordAt(text, index, statusMarkers);
  if (status) return { kind: 'status', text: status };

  const risk = matchKeywordAt(text, index, RISK_MARKERS);
  if (risk) return { kind: 'risk', text: risk };

  return undefined;
}

function matchKeywordAt(
  text: string,
  index: number,
  markers: readonly string[],
): string | undefined {
  const rest = text.slice(index);
  for (const marker of markers) {
    if (rest.startsWith(marker) && hasWordBoundary(text, index, marker.length)) {
      return marker;
    }
  }
  return undefined;
}

function matchPatternAt(text: string, index: number, pattern: RegExp): string | undefined {
  const match = pattern.exec(text.slice(index));
  const value = match?.[0];
  return value && value.length > 0 ? value : undefined;
}

function hasWordBoundary(text: string, index: number, length: number): boolean {
  return !isWordChar(text[index - 1]) && !isWordChar(text[index + length]);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_-]/.test(char);
}

function workflowMarkdownPartToConversationSegment(
  part: WorkflowMarkdownPart,
): ConversationRowSegment {
  switch (part.kind) {
    case 'base':
      return markdownSegment(part.segment);
    case 'taskId':
      return { text: part.text, tone: 'text', bold: true };
    case 'filePath':
      return { text: part.text, tone: 'textDim' };
    case 'status':
      return { text: part.text, tone: 'textDim' };
    case 'risk':
      return { text: part.text, tone: 'textDim' };
    default:
      return assertNever(part);
  }
}

function workflowMarkdownPartToRenderSegment(
  part: WorkflowMarkdownPart,
  theme: Theme,
): MarkdownRenderSegment {
  switch (part.kind) {
    case 'base':
      return { text: part.segment.text };
    case 'taskId':
      return { text: part.text };
    case 'filePath':
      return { text: part.text, style: { color: theme.textDim } };
    case 'status':
      return { text: part.text, style: { color: statusColor(part.text, theme), bold: false } };
    case 'risk':
      return { text: part.text };
    default:
      return assertNever(part);
  }
}

function markdownSegment(segment: MarkdownLayoutSegment): ConversationRowSegment {
  switch (segment.kind) {
    case 'heading':
      return { text: segment.text, tone: 'text', bold: true };
    case 'metadata':
      return { text: segment.text, tone: 'textDim' };
    case 'rule':
      return { text: segment.text, tone: 'textDim' };
    case 'listMarker':
      return { text: segment.text, tone: 'text' };
    case 'blockquoteMarker':
      return { text: segment.text, tone: 'textDim' };
    case 'code':
      return { text: segment.text, tone: 'textDim' };
    case 'bold':
      return { text: segment.text, tone: 'text', bold: true };
    case 'italic':
      return { text: segment.text, tone: 'textDim', italic: true };
    case 'boldItalic':
      return { text: segment.text, tone: 'text', bold: true, italic: true };
    case 'text':
      return { text: segment.text, tone: 'text' };
    default:
      return assertNever(segment.kind);
  }
}

function statusColor(text: string, theme: Theme): string {
  const value = text.toUpperCase();
  if (
    value.includes('FAIL') ||
    value.includes('ERROR') ||
    value.includes('BLOCKED') ||
    value.includes('NOT VERIFIED')
  ) {
    return STATUS_DIM_ERROR;
  }
  if (value.includes('WARN') || value.includes('INCONCLUSIVE')) return theme.textDim;
  return STATUS_DIM_SUCCESS;
}
