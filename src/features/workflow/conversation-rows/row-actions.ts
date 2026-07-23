import { diffEventKey } from '../../../core/sections/event-sections.js';
import type { ConversationRowInputs, RowBuildContext } from './types.js';
import { activityBatchKey } from './activity-batch-key.js';
import { buildActivityBatchViewModel } from './activity-batch-model.js';
import { eventRowBlock } from './event-rows/dispatch.js';
import { runnerActivityBatchRowBlock } from './activity-rows.js';
import { walkTranscript, type RunnerActivityBatch } from './transcript-walk.js';

const MIN_ROW_WIDTH = 1;

export type ConversationRowAction =
  | { type: 'toggle-diff'; key: string }
  | { type: 'toggle-activity-batch'; key: string };

// Maps each actionable transcript row key to its expand/collapse action so a click on the row can
// trigger the same toggle as the keyboard. Only the activity disclosure (`+N more` / `collapse`) and
// diff rows are actionable; every other row key is absent and a click on it is inert. Shares
// walkTranscript with the projection so its batch grouping matches the rendered rows exactly.
export function buildConversationRowActions(
  inputs: ConversationRowInputs,
): Map<string, ConversationRowAction> {
  const ctx: RowBuildContext = {
    width: Math.max(MIN_ROW_WIDTH, inputs.cols),
    viewportRows: inputs.viewportHeight,
    streaming: inputs.streaming,
  };
  const actions = new Map<string, ConversationRowAction>();

  const flushActivityBatch = (batch: RunnerActivityBatch): void => {
    const batchKey = activityBatchKey(batch.firstIndex, batch.callId);
    const model = buildActivityBatchViewModel({
      events: [...batch.events],
      batchKey,
      expanded: inputs.expandedActivityBatches.has(batchKey),
    });
    if (model.expandableKey === null) return;
    const block = runnerActivityBatchRowBlock({ model, width: ctx.width });
    if (block === null) return;
    for (const row of block.createRows(0, block.rowCount)) {
      if (row.kind === 'activity-more') {
        actions.set(row.key, { type: 'toggle-activity-batch', key: batchKey });
      }
    }
  };

  for (const step of walkTranscript(inputs.sections)) {
    if (step.kind === 'activity-batch') {
      flushActivityBatch(step.batch);
      continue;
    }
    const { event, globalIndex } = step;
    if (event.type === 'implementer_generate_done' && event.diff) {
      const key = diffEventKey(event, globalIndex);
      const block = eventRowBlock({
        event,
        globalIndex,
        ctx,
        expanded: inputs.expandedDiffs.has(key),
      });
      if (block !== null) {
        for (const row of block.createRows(0, block.rowCount)) {
          actions.set(row.key, { type: 'toggle-diff', key });
        }
      }
    }
  }

  return actions;
}
