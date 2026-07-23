import type { ConversationRow, ConversationRowsProjection } from './types.js';

export function materializeConversationRowsWindow(options: {
  projection: ConversationRowsProjection;
  windowStart: number;
  windowEnd: number;
}): ConversationRow[] {
  const { projection, windowStart, windowEnd } = options;
  const rows: ConversationRow[] = [];
  const start = Math.max(0, windowStart);
  const end = Math.max(start, windowEnd);
  let cursor = 0;

  for (const block of projection.blocks) {
    const blockStart = cursor;
    const blockEnd = cursor + block.rowCount;
    cursor = blockEnd;
    if (blockEnd <= start) continue;
    if (blockStart >= end) break;

    rows.push(
      ...block.createRows(
        Math.max(0, start - blockStart),
        Math.min(block.rowCount, end - blockStart),
      ),
    );
  }

  return rows;
}
