import { diffEventKey, type Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import type {
  ConversationRowInputs,
  ConversationRowsProjection,
  ConversationRowBlock,
  RowBuildContext,
} from './types.js';
import { blankRow } from './row-format/rows.js';
import { wrapWidthFor } from './row-markers.js';
import { activityBatchKey } from './activity-batch-key.js';
import { buildActivityBatchViewModel } from './activity-batch-model.js';
import {
  getCachedActivityBatchBlock,
  getCachedEventRowBlock,
  rememberActivityBatchBlock,
  rememberEventRowBlock,
  type EventBlockCacheKey,
} from './block-cache.js';
import { eventRowBlock, recoveryRowBlock } from './event-rows/dispatch.js';
import { joinsCheckList } from './check-list-spacing.js';
import { isPlannerTextRenderedAsMarkdown } from './event-rows/planner-text.js';
import { runnerActivityBatchRowBlock } from './activity-rows.js';
import {
  beginMarkdownConversationRowsProjectionPass,
  markdownConversationRowsCacheKey,
} from './markdown-rows.js';
import { settledRowBlock } from './settled-row-block.js';
import { stageHeadingParts } from '../components/conversation-flow/stage-summary.js';
import { isTranscriptRowlessEvent } from './event-rows/visibility.js';
import { isRunnerCallTranscriptRowSuppressed } from './runner-call-classification.js';
import { rowsBlock } from './row-block-compose.js';
import { segmentedRow } from './row-format/rows.js';
import { walkTranscript, type RunnerActivityBatch } from './transcript-walk.js';

const MIN_ROW_WIDTH = 1;
// One blank row separates consecutive top-level transcript sections, giving the log a calmer
// one-row rhythm. renderableUnits stays 0 so the spacer never registers as a scrolled-past event.
const SECTION_SPACER_ROWS = 1;

export function buildConversationRowsProjection(
  inputs: ConversationRowInputs,
): ConversationRowsProjection {
  const ctx: RowBuildContext = {
    width: Math.max(MIN_ROW_WIDTH, inputs.cols),
    viewportRows: inputs.viewportHeight,
    streaming: inputs.streaming,
  };
  const markdownWidth = wrapWidthFor('message', ctx.width);
  const endMarkdownProjectionPass = beginMarkdownConversationRowsProjectionPass(
    markdownProjectionCacheKeys(inputs.sections, markdownWidth),
  );

  try {
    return buildConversationRowsProjectionWithContext(inputs, ctx);
  } finally {
    endMarkdownProjectionPass();
  }
}

function buildConversationRowsProjectionWithContext(
  inputs: ConversationRowInputs,
  ctx: RowBuildContext,
): ConversationRowsProjection {
  const blocks: ConversationRowBlock[] = [];
  const activeTask = inputs.sections.find((section) => section.type === 'active-task');
  let activeTaskHeaderKey: string | null = null;
  let renderableCount = 0;
  let hasRenderableBlock = false;
  let lastAppendedType: EngineEvent['type'] | undefined;
  // The feature/prompt, captured from the first user_message so the planner's opening H1 echo of it
  // can be stripped (the prompt already renders as the first transcript row).
  let dedupTitle: string | undefined;

  const appendBlock = (
    block: ConversationRowBlock,
    eventType?: EngineEvent['type'],
    sectionBoundary = false,
  ): void => {
    if (block.rowCount === 0) return;
    if (hasRenderableBlock && (sectionBoundary || !joinsCheckList(lastAppendedType, eventType))) {
      blocks.push({
        key: `spacer-${block.key}`,
        rowCount: SECTION_SPACER_ROWS,
        renderableUnits: 0,
        createRows: (windowStart, windowEnd) =>
          Array.from({ length: Math.max(0, windowEnd - windowStart) }, (_, offset) =>
            blankRow(`spacer-${block.key}-${windowStart + offset}`),
          ),
      });
    }
    blocks.push(block);
    hasRenderableBlock = true;
    lastAppendedType = eventType;
    renderableCount += block.renderableUnits;
  };

  const flushActivityBatch = (batch: RunnerActivityBatch, settled: boolean): void => {
    const batchKey = activityBatchKey(batch.firstIndex, batch.callId);
    const events = [...batch.events];
    const expanded = inputs.expandedActivityBatches.has(batchKey);
    const key = { batchKey, count: events.length, width: ctx.width, expanded, settled };
    let block = getCachedActivityBatchBlock(batch.lastEvent, key);
    if (block === undefined) {
      const model = buildActivityBatchViewModel({ events, batchKey, expanded });
      block = runnerActivityBatchRowBlock({
        model,
        width: ctx.width,
      });
      if (settled && block !== null) block = withoutActiveRow(block);
      rememberActivityBatchBlock(batch.lastEvent, key, block);
    }
    if (block !== null) appendBlock(block);
  };

  for (const step of walkTranscript(inputs.sections)) {
    if (step.kind === 'review-heading') {
      if (
        step.items.every(
          (event) => isTranscriptRowlessEvent(event) || isRunnerCallTranscriptRowSuppressed(event),
        )
      )
        continue;
      const key = `review-${step.startIndex}`;
      const block = rowsBlock(key, [segmentedRow(key, stageHeadingParts(step.review), 'section')]);
      if (block !== null) appendBlock(block, undefined, true);
      continue;
    }
    if (step.kind === 'settled') {
      appendBlock(settledRowBlock({ section: step.section, width: ctx.width }), undefined, true);
      continue;
    }
    if (step.kind === 'settled-end') {
      appendBlock(settledRowBlock({ section: step.section, width: ctx.width }));
      continue;
    }
    if (step.kind === 'activity-batch') {
      flushActivityBatch(step.batch, step.settledSection !== undefined || step.callEnded);
      continue;
    }
    if (step.kind === 'recovery') {
      const block = recoveryRowBlock(
        `event-${step.recovery.firstIndex}-recovery`,
        step.recovery,
        ctx.width,
        step.recovery.prompted !== undefined &&
          inputs.expandedDiffs.has(diffEventKey(step.recovery.prompted, step.recovery.firstIndex)),
      );
      if (block !== null) appendBlock(block);
      continue;
    }
    const { event, globalIndex } = step;

    if (event.type === 'user_message' && dedupTitle === undefined) {
      dedupTitle = event.text;
    }

    const expanded = inputs.expandedDiffs.has(diffEventKey(event, globalIndex));
    const blockKey: EventBlockCacheKey = {
      width: ctx.width,
      viewportRows: ctx.viewportRows,
      expanded,
      keyPrefix: String(globalIndex),
      dedupTitle,
      settled: step.settledSection !== undefined,
    };
    const cacheable = event.type !== 'seat_switched';
    let block = cacheable ? getCachedEventRowBlock(event, blockKey) : undefined;
    if (block === undefined) {
      block = eventRowBlock({
        event,
        globalIndex,
        ctx,
        expanded,
        dedupTitle,
        settledSection: step.settledSection,
        causeInRecovery: step.causeInRecovery,
      });
      if (step.settledSection !== undefined && block !== null) block = withoutActiveRow(block);
      if (cacheable) rememberEventRowBlock(event, blockKey, block);
    }
    if (block === null) continue;
    if (step.historicalTaskHeader === true) {
      const historical = withoutActiveRow(block);
      block = {
        ...historical,
        createRows: (start, end) =>
          historical.createRows(start, end).map((row) => ({
            ...row,
            kind: 'section',
            segments: row.segments.map((segment) => ({ ...segment, tone: 'textDim', bold: false })),
          })),
      };
    }
    if (event.type === 'task_started' && activeTask?.items.includes(event)) {
      activeTaskHeaderKey = block.activeRowKey ?? null;
    }
    appendBlock(block, event.type);
  }

  const totalRows = blocks.reduce((count, block) => count + block.rowCount, 0);
  return { blocks, renderableCount, totalRows, activeTaskHeaderKey };
}

function withoutActiveRow(block: ConversationRowBlock): ConversationRowBlock {
  return {
    key: block.key,
    rowCount: block.rowCount,
    renderableUnits: block.renderableUnits,
    createRows: block.createRows,
  };
}

function markdownProjectionCacheKeys(
  sections: readonly Section<EngineEvent>[],
  width: number,
): string[] {
  const keys: string[] = [];
  for (const section of sections) {
    for (const [index, event] of section.items.entries()) {
      if (event.type !== 'planner_text' || !isPlannerTextRenderedAsMarkdown(event)) continue;
      const keyPrefix = `event-${section.startIndex + index}-${event.type}`;
      keys.push(
        markdownConversationRowsCacheKey({
          keyPrefix,
          width,
        }),
      );
      if (event.role === 'implementer') {
        keys.push(
          markdownConversationRowsCacheKey({ keyPrefix: `${keyPrefix}-narration-0`, width }),
        );
      }
    }
  }
  return keys;
}
