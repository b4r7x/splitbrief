import type { ConversationRow, ConversationRowInputs, ConversationRowsResult, RowBuildContext } from './types.js';
import { blankRow } from './row-format.js';
import { eventRows } from './event-rows.js';

const MIN_ROW_WIDTH = 1;

export function buildConversationRows(inputs: ConversationRowInputs): ConversationRowsResult {
  const rows: ConversationRow[] = [];
  let renderableCount = 0;
  const ctx: RowBuildContext = {
    width: Math.max(MIN_ROW_WIDTH, inputs.cols),
    viewportRows: inputs.viewportHeight,
    streaming: inputs.streaming,
  };

  for (const section of inputs.sections) {
    if (section.type === 'completed-task') continue;
    for (const [index, event] of section.items.entries()) {
      const globalIndex = section.startIndex + index;
      const eventRowList = eventRows(event, globalIndex, ctx, inputs.expandedDiffs.has(globalIndex));
      if (eventRowList.length === 0) continue;
      if (rows.length > 0) rows.push(blankRow(`spacer-${globalIndex}`));
      rows.push(...eventRowList);
      renderableCount++;
    }
  }

  return { rows, renderableCount };
}
