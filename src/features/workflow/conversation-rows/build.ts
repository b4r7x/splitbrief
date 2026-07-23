import type { Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { diffEventKey } from '../../../core/sections/event-sections.js';
import type {
  ConversationRowInputs,
  ConversationRowsResult,
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
import { eventRowBlock } from './event-rows/dispatch.js';
import { isPlannerTextRenderedAsMarkdown } from './event-rows/planner-text.js';
import { runnerActivityBatchRowBlock } from './activity-rows.js';
import {
  beginMarkdownConversationRowsProjectionPass,
  markdownConversationRowsCacheKey,
} from './markdown-rows.js';
import { materializeConversationRowsWindow } from './materialize-window.js';
import { walkTranscript, type RunnerActivityBatch } from './transcript-walk.js';

const MIN_ROW_WIDTH = 1;
// One blank row separates consecutive top-level transcript sections, giving the log a calmer
// one-row rhythm. renderableUnits stays 0 so the spacer never registers as a scrolled-past event.
const SECTION_SPACER_ROWS = 1;

export function buildConversationRows(inputs: ConversationRowInputs): ConversationRowsResult {
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
  let renderableCount = 0;
  let hasRenderableBlock = false;
  // The feature/prompt, captured from the first user_message so the planner's opening H1 echo of it
  // can be stripped (the prompt already renders as the first transcript row).
  let dedupTitle: string | undefined;

  const appendBlock = (block: ConversationRowBlock, globalIndex: number): void => {
    if (block.rowCount === 0) return;
    if (hasRenderableBlock) {
      blocks.push({
        key: `spacer-${globalIndex}`,
        rowCount: SECTION_SPACER_ROWS,
        renderableUnits: 0,
        createRows: (windowStart, windowEnd) =>
          Array.from({ length: Math.max(0, windowEnd - windowStart) }, (_, offset) =>
            blankRow(`spacer-${globalIndex}-${windowStart + offset}`),
          ),
      });
    }
    blocks.push(block);
    hasRenderableBlock = true;
    renderableCount += block.renderableUnits;
  };

  const flushActivityBatch = (batch: RunnerActivityBatch): void => {
    const batchKey = activityBatchKey(batch.firstIndex, batch.callId);
    const events = [...batch.events];
    const expanded = inputs.expandedActivityBatches.has(batchKey);
    const key = { batchKey, count: events.length, width: ctx.width, expanded };
    let block = getCachedActivityBatchBlock(batch.lastEvent, key);
    if (block === undefined) {
      const model = buildActivityBatchViewModel({ events, batchKey, expanded });
      block = runnerActivityBatchRowBlock({ model, width: ctx.width });
      rememberActivityBatchBlock(batch.lastEvent, key, block);
    }
    if (block !== null) appendBlock(block, batch.firstIndex);
  };

  for (const step of walkTranscript(inputs.sections)) {
    if (step.kind === 'activity-batch') {
      flushActivityBatch(step.batch);
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
    };
    let block = getCachedEventRowBlock(event, blockKey);
    if (block === undefined) {
      block = eventRowBlock({ event, globalIndex, ctx, expanded, dedupTitle });
      rememberEventRowBlock(event, blockKey, block);
    }
    if (block === null) continue;
    appendBlock(block, globalIndex);
  }

  const totalRows = blocks.reduce((count, block) => count + block.rowCount, 0);
  return { blocks, renderableCount, totalRows };
}

function markdownProjectionCacheKeys(
  sections: readonly Section<EngineEvent>[],
  width: number,
): string[] {
  const keys: string[] = [];
  for (const section of sections) {
    if (section.type === 'completed-task') continue;
    for (const [index, event] of section.items.entries()) {
      if (event.type !== 'planner_text' || !isPlannerTextRenderedAsMarkdown(event)) continue;
      keys.push(
        markdownConversationRowsCacheKey({
          keyPrefix: `event-${section.startIndex + index}-${event.type}`,
          width,
        }),
      );
    }
  }
  return keys;
}
