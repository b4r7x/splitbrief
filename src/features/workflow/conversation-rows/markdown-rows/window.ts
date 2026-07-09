import { firstContentSegmentIndex } from '../../../../components/markdown.js';
import type { MarkdownLayoutLine, MarkdownLayoutRow } from '../../../../utils/markdown/types.js';
import type { ConversationRow } from '../types.js';
import type {
  MarkdownConversationRowsProjection,
  MarkdownLayoutChunk,
  MarkdownRowsCacheEntry,
} from './types.js';
import { workflowMarkdownConversationSegments } from './workflow-markers.js';

export function createMarkdownRowsCacheEntryFromChunks(input: {
  sourceText: string;
  keyPrefix: string;
  chunks: readonly MarkdownLayoutChunk[];
  projectDir: string | undefined;
}): MarkdownRowsCacheEntry {
  const rows = input.chunks.flatMap((chunk) => chunk.rows);
  const rowCount = input.chunks.reduce((sum, chunk) => sum + chunk.height, 0);
  const keyPrefix = input.keyPrefix;
  const projectDir = input.projectDir;
  const projection: MarkdownConversationRowsProjection = {
    rowCount,
    createRows: (windowStart, windowEnd) =>
      markdownLayoutWindowRows({
        keyPrefix,
        rows,
        windowStart,
        windowEnd,
        projectDir,
      }),
  };

  return {
    sourceText: input.sourceText,
    chunks: input.chunks,
    projection,
  };
}

function markdownLayoutWindowRows(input: {
  keyPrefix: string;
  rows: readonly MarkdownLayoutRow[];
  windowStart: number;
  windowEnd: number;
  projectDir: string | undefined;
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
        segments: markdownLineSegments(line, layoutRow.lines[localIndex - 1], input.projectDir),
      });
    }
  }

  return rows;
}

function markdownLineSegments(
  line: MarkdownLayoutLine,
  previousLine: MarkdownLayoutLine | undefined,
  projectDir: string | undefined,
) {
  const previousLineText = previousLine?.segments.map((segment) => segment.text).join('');
  const contentIndex = firstContentSegmentIndex(line.segments);
  return line.segments.flatMap((segment, segmentIndex) =>
    workflowMarkdownConversationSegments(segment, {
      projectDir,
      previousLineText: segmentIndex === contentIndex ? previousLineText : undefined,
    }),
  );
}
