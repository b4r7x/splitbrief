import { diffEventKey } from '../../../core/sections/events.js';
import type {
  ConversationRowBlock,
  ConversationRowInputs,
  ConversationRowScrollInputs,
  RowBuildContext,
} from './types.js';
import { activityBatchKey } from './activity-batch-key.js';
import { buildActivityBatchViewModel } from './activity-batch-model.js';
import { implementerFailureCard, eventRowBlock, recoveryRowBlock } from './event-rows/dispatch.js';
import { runnerActivityBatchRowBlock } from './activity-rows.js';
import { checkGroupKey, checkGroupRowBlock } from './check-group-rows.js';
import {
  walkTranscript,
  type RunnerActivityBatch,
  type TranscriptWalkStep,
} from './transcript-walk.js';

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

// The key of the diff toggle that a transcript step takes, or null: a Recovery row with
// diagnostics, a done brief with a diff, or a failure card whose cause was cut. The row actions and
// the row model both ask it, so a row that takes the toggle and the latest toggle key agree.
export function diffToggleKey(
  step: Extract<TranscriptWalkStep, { kind: 'recovery' | 'event' }>,
  width: number,
): string | null {
  if (step.kind === 'recovery') {
    const { recovery } = step;
    return recovery.prompted !== undefined && (recovery.diagnostics?.length ?? 0) > 0
      ? diffEventKey(recovery.prompted, recovery.firstIndex)
      : null;
  }
  const { event, globalIndex } = step;
  const expandable =
    (event.type === 'implementer_generate_done' && (event.diff ?? '') !== '') ||
    (event.type === 'implementer_generate_failed' &&
      implementerFailureCard(event, width, false).expandable);
  return expandable ? diffEventKey(event, globalIndex) : null;
}

// Maps each actionable transcript row key to its expand/collapse action so a click on the row can
// trigger the same toggle as the keyboard. Only a fold row (`+N earlier` / `+N more` / `collapse`)
// of an activity batch, a check group or a block at the tail, diff rows and a failure card whose
// cause was cut are actionable. Every other row key is absent and a click on it is inert. Shares
// walkTranscript with the projection so its batch grouping matches the rendered rows exactly. The
// tail comes last, so the latest fold is the lowest one on the screen.
export function buildConversationRowActions(
  inputs: ConversationRowInputs & Pick<ConversationRowScrollInputs, 'tail'>,
): Map<string, ConversationRowAction> {
  const ctx: RowBuildContext = {
    width: Math.max(MIN_ROW_WIDTH, inputs.cols),
    viewportRows: inputs.viewportHeight,
    streaming: inputs.streaming,
  };
  const actions = new Map<string, ConversationRowAction>();

  const registerFoldRows = (block: ConversationRowBlock, key: string): void => {
    if (block.foldRowKey !== undefined)
      actions.set(block.foldRowKey, { type: 'toggle-activity-batch', key });
  };

  const flushActivityBatch = (batch: RunnerActivityBatch): void => {
    const batchKey = activityBatchKey(batch.firstIndex, batch.callId);
    const model = buildActivityBatchViewModel({
      events: [...batch.events],
      batchKey,
      expanded: inputs.expandedActivityBatches.has(batchKey),
    });
    if (model.expandableKey === null) return;
    const block = runnerActivityBatchRowBlock({ model, width: ctx.width });
    if (block !== null) registerFoldRows(block, batchKey);
  };

  for (const step of walkTranscript(inputs.sections)) {
    if (step.kind === 'settled' || step.kind === 'settled-end' || step.kind === 'review-heading')
      continue;
    if (step.kind === 'activity-batch') {
      flushActivityBatch(step.batch);
      continue;
    }
    if (step.kind === 'check-group') {
      const block = checkGroupRowBlock({
        checks: step.checks,
        firstIndex: step.firstIndex,
        expanded: inputs.expandedActivityBatches.has(checkGroupKey(step.firstIndex)),
        width: ctx.width,
        open: step.open,
      });
      registerFoldRows(block, block.key);
      continue;
    }
    const key = diffToggleKey(step, ctx.width);
    if (step.kind === 'recovery') {
      if (key !== null) {
        const block = recoveryRowBlock(
          `event-${step.recovery.firstIndex}-recovery`,
          step.recovery,
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
    if (key !== null) {
      const block = eventRowBlock({
        event: step.event,
        globalIndex: step.globalIndex,
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

  for (const block of inputs.tail ?? []) registerFoldRows(block, block.key);

  return actions;
}
