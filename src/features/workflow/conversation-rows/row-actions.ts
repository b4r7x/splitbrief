import { diffEventKey } from '../../../core/sections/event-sections.js';
import type { ConversationRowInputs, RowBuildContext } from './types.js';
import { activityBatchKey } from './activity-batch-key.js';
import { buildActivityBatchViewModel } from './activity-batch-model.js';
import {
  COLLAPSED_DRIFT_FINDING_LIMIT,
  orderedDriftFindings,
  implementerFailureCard,
  eventRowBlock,
  recoveryRowBlock,
} from './event-rows/dispatch.js';
import { runnerActivityBatchRowBlock } from './activity-rows.js';
import { walkTranscript, type RunnerActivityBatch } from './transcript-walk.js';

const MIN_ROW_WIDTH = 1;

export type ConversationRowAction =
  | { type: 'toggle-diff'; key: string }
  | { type: 'toggle-activity-batch'; key: string };

export function findLatestConversationRowAction(
  actions: ReadonlyMap<string, ConversationRowAction>,
  type: ConversationRowAction['type'],
): ConversationRowAction | null {
  return [...actions.values()].findLast((action) => action.type === type) ?? null;
}

// Maps each actionable transcript row key to its expand/collapse action so a click on the row can
// trigger the same toggle as the keyboard. Only the activity disclosure (`+N more` / `collapse`),
// diff rows, drift rows with hidden findings and a failure card whose cause was cut are actionable.
// Every other row key is absent and a click on it is inert. Shares walkTranscript with the
// projection so its batch grouping matches the rendered rows exactly.
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
    if (step.kind === 'settled' || step.kind === 'settled-end' || step.kind === 'review-heading')
      continue;
    if (step.kind === 'activity-batch') {
      flushActivityBatch(step.batch);
      continue;
    }
    if (step.kind === 'recovery') {
      const { recovery } = step;
      if (recovery.prompted !== undefined && (recovery.diagnostics?.length ?? 0) > 0) {
        const key = diffEventKey(recovery.prompted, recovery.firstIndex);
        const block = recoveryRowBlock(
          `event-${recovery.firstIndex}-recovery`,
          recovery,
          ctx.width,
          inputs.expandedDiffs.has(key),
        );
        if (block !== null) {
          for (const row of block.createRows(0, block.rowCount)) {
            actions.set(row.key, { type: 'toggle-diff', key });
          }
        }
      }
      continue;
    }
    const { event, globalIndex } = step;
    const expandable =
      (event.type === 'implementer_generate_done' && (event.diff ?? '') !== '') ||
      (event.type === 'implementer_generate_failed' &&
        implementerFailureCard(event, ctx.width, false).expandable) ||
      (event.type === 'drift_report' &&
        orderedDriftFindings(event).length > COLLAPSED_DRIFT_FINDING_LIMIT);
    if (expandable) {
      const key = diffEventKey(event, globalIndex);
      const block = eventRowBlock({
        event,
        globalIndex,
        ctx,
        expanded: inputs.expandedDiffs.has(key),
        settledSection: step.settledSection,
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
