import type { ConversationRow, ConversationRowBlock, ConversationRowSegment } from './types.js';
import { segmentedRow } from './row-format/rows.js';
import { sanitizeRowDisplayText, wrappedRowTexts } from './row-format/text.js';
import { wrapWidthFor } from './row-markers.js';

export function taskStartedRowBlock(input: {
  keyPrefix: string;
  index: number;
  title: string;
  metadata: string;
  width: number;
}): ConversationRowBlock | null {
  const indexText = sanitizeRowDisplayText(`T${input.index + 1}`);
  const titleText = sanitizeRowDisplayText(` ${input.title}`);
  const metadataText = sanitizeRowDisplayText(`  ${input.metadata}`);
  const fullText = `${indexText}${titleText}${metadataText}`;
  const indexEnd = indexText.length;
  const titleEnd = indexEnd + titleText.length;

  const wrapped = wrappedRowTexts(fullText, wrapWidthFor('task-header', input.width));
  if (wrapped.length === 0) return null;

  const rows: ConversationRow[] = [];
  let offset = 0;
  for (let lineIndex = 0; lineIndex < wrapped.length; lineIndex += 1) {
    const line = wrapped[lineIndex] ?? '';
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const segments: ConversationRowSegment[] = [];
    let pos = lineStart;
    while (pos < lineEnd) {
      let regionEnd: number;
      let tone: ConversationRowSegment['tone'];
      let bold = false;
      if (pos < indexEnd) {
        regionEnd = Math.min(indexEnd, lineEnd);
        tone = 'text';
        bold = true;
      } else if (pos < titleEnd) {
        regionEnd = Math.min(titleEnd, lineEnd);
        tone = 'text';
        bold = true;
      } else {
        regionEnd = lineEnd;
        tone = 'textDim';
      }
      const segment: ConversationRowSegment = {
        text: line.slice(pos - lineStart, regionEnd - lineStart),
        tone,
      };
      if (bold) segment.bold = true;
      segments.push(segment);
      pos = regionEnd;
    }
    rows.push(segmentedRow(`${input.keyPrefix}-${lineIndex}`, segments, 'task-header'));
    offset = lineEnd;
  }

  const activeRowKey = rows[rows.length - 1]?.key;

  return {
    key: input.keyPrefix,
    rowCount: rows.length,
    renderableUnits: 1,
    ...(activeRowKey !== undefined ? { activeRowKey } : {}),
    createRows: (windowStart, windowEnd) => rows.slice(windowStart, windowEnd),
  };
}
