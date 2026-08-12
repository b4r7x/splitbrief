import type { ConversationRow, ConversationRowBlock, ConversationRowSegment } from './types.js';
import { segmentedRow } from './row-format/rows.js';
import { sanitizeRowDisplayText, wrappedRowTexts } from './row-format/text.js';
import { wrapWidthFor } from './row-markers.js';

// A wrapped continuation carries the space it broke on, and when the break lands before a
// separator it carries that too — `· sonnet` on its own row reads as a new bullet, not as the tail
// of the row above. The continuation marker already says the row continues, so the break debris goes.
const LEADING_BREAK = /^\s+(?:·\s+)?|^·\s+/;

function withoutLeadingBreak(segments: ConversationRowSegment[]): ConversationRowSegment[] {
  const [first, ...rest] = segments;
  if (first === undefined) return segments;
  const text = first.text.replace(LEADING_BREAK, '');
  if (text === first.text) return segments;
  return text.length === 0 ? rest : [{ ...first, text }, ...rest];
}

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
    const row = segmentedRow(
      `${input.keyPrefix}-${lineIndex}`,
      lineIndex === 0 ? segments : withoutLeadingBreak(segments),
      'task-header',
    );
    rows.push(lineIndex === 0 ? row : { ...row, headerContinuation: true });
    offset = lineEnd;
  }

  // The marker lives on the first row — every later row is a continuation and draws the message
  // leading. Pointing "active" at the last row left a running task wearing the done glyph.
  const activeRowKey = rows[0]?.key;

  return {
    key: input.keyPrefix,
    rowCount: rows.length,
    renderableUnits: 1,
    ...(activeRowKey !== undefined ? { activeRowKey } : {}),
    createRows: (windowStart, windowEnd) => rows.slice(windowStart, windowEnd),
  };
}
