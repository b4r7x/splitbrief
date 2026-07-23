import { eventRowBlock } from '../../src/features/workflow/conversation-rows/event-rows/dispatch.js';
import type { ConversationRow } from '../../src/features/workflow/conversation-rows/types.js';

export function eventRows(options: Parameters<typeof eventRowBlock>[0]): ConversationRow[] {
  const block = eventRowBlock(options);
  return block === null ? [] : block.createRows(0, block.rowCount);
}
