import { eventRowBlock } from '../../src/features/workflow/conversation-rows/event-rows/dispatch.js';
import { buildConversationRowsProjection } from '../../src/features/workflow/conversation-rows/build.js';
import { markdownConversationRowsProjection } from '../../src/features/workflow/conversation-rows/markdown-rows.js';
import type { MarkdownConversationRowsInput } from '../../src/features/workflow/conversation-rows/markdown-rows/types.js';
import { materializeConversationRowsWindow } from '../../src/features/workflow/conversation-rows/materialize-window.js';
import type {
  ConversationRow,
  ConversationRowInputs,
} from '../../src/features/workflow/conversation-rows/types.js';

export function buildConversationRows(inputs: ConversationRowInputs): {
  rows: ConversationRow[];
  renderableCount: number;
} {
  const projection = buildConversationRowsProjection(inputs);
  return {
    rows: materializeConversationRowsWindow({
      projection,
      windowStart: 0,
      windowEnd: projection.totalRows,
    }),
    renderableCount: projection.renderableCount,
  };
}

export function markdownConversationRows(input: MarkdownConversationRowsInput): ConversationRow[] {
  const projection = markdownConversationRowsProjection(input);
  return projection.createRows(0, projection.rowCount);
}

export function eventRows(options: Parameters<typeof eventRowBlock>[0]): ConversationRow[] {
  const block = eventRowBlock(options);
  return block === null ? [] : block.createRows(0, block.rowCount);
}
