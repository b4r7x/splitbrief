import type { Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import { diffEventKey } from '../../../core/sections/event-sections.js';
import type {
  ConversationRow,
  ConversationRowInputs,
  ConversationRowsResult,
  ConversationRowsProjection,
  ConversationRowBlock,
  RowBuildContext,
} from './types.js';
import { blankRow } from './row-format.js';
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
import { eventRowBlock, isPlannerTextRenderedAsMarkdown } from './event-rows.js';
import { runnerActivityBatchRowBlock } from './activity-rows.js';
import { runnerCallId } from './runner-call-classification.js';
import {
  beginMarkdownConversationRowsProjectionPass,
  markdownConversationRowsCacheKey,
} from './markdown-rows.js';

const MIN_ROW_WIDTH = 1;
// One blank row separates consecutive top-level transcript sections, giving the log a calmer
// one-row rhythm. renderableUnits stays 0 so the spacer never registers as a scrolled-past event.
const SECTION_SPACER_ROWS = 1;

export type ConversationRowAction =
  | { type: 'toggle-diff'; key: string }
  | { type: 'toggle-activity-batch'; key: string };

type RunnerActivityEvent = EngineEventOf<'runner_call_activity'>;

interface RunnerActivityBatch {
  callId: string;
  firstIndex: number;
  events: RunnerActivityEvent[];
  lastEvent: RunnerActivityEvent;
}

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
  let activityBatch: RunnerActivityBatch | null = null;
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

  const flushActivityBatch = (): void => {
    if (activityBatch === null) return;
    const batchKey = activityBatchKey(activityBatch.firstIndex, activityBatch.callId);
    const events = [...activityBatch.events];
    const firstIndex = activityBatch.firstIndex;
    const expanded = inputs.expandedActivityBatches.has(batchKey);
    const key = { batchKey, count: events.length, width: ctx.width, expanded };
    let block = getCachedActivityBatchBlock(activityBatch.lastEvent, key);
    if (block === undefined) {
      const model = buildActivityBatchViewModel({ events, batchKey, expanded });
      block = runnerActivityBatchRowBlock({ model, width: ctx.width });
      rememberActivityBatchBlock(activityBatch.lastEvent, key, block);
    }
    if (block !== null) appendBlock(block, firstIndex);
    activityBatch = null;
  };

  for (const section of inputs.sections) {
    if (section.type === 'completed-task') {
      flushActivityBatch();
      continue;
    }
    for (const [index, event] of section.items.entries()) {
      const globalIndex = section.startIndex + index;
      if (event.type === 'runner_call_activity') {
        if (activityBatch !== null && activityBatch.callId === event.callId) {
          activityBatch.events.push(event);
          activityBatch.lastEvent = event;
        } else {
          flushActivityBatch();
          activityBatch = {
            callId: event.callId,
            firstIndex: globalIndex,
            events: [event],
            lastEvent: event,
          };
        }
        continue;
      }

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
      if (block === null) {
        if (!belongsToActivityBatch(event, activityBatch)) flushActivityBatch();
        continue;
      }
      flushActivityBatch();
      appendBlock(block, globalIndex);
    }
  }

  flushActivityBatch();
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

// Maps each actionable transcript row key to its expand/collapse action so a click on the row can
// trigger the same toggle as the keyboard. Only the activity disclosure (`+N more` / `collapse`) and
// diff rows are actionable; every other row key is absent and a click on it is inert.
export function buildConversationRowActions(
  inputs: ConversationRowInputs,
): Map<string, ConversationRowAction> {
  const ctx: RowBuildContext = {
    width: Math.max(MIN_ROW_WIDTH, inputs.cols),
    viewportRows: inputs.viewportHeight,
    streaming: inputs.streaming,
  };
  const actions = new Map<string, ConversationRowAction>();
  let activityBatch: RunnerActivityBatch | null = null;

  const flushActivityBatch = (): void => {
    if (activityBatch === null) return;
    const batchKey = activityBatchKey(activityBatch.firstIndex, activityBatch.callId);
    const model = buildActivityBatchViewModel({
      events: [...activityBatch.events],
      batchKey,
      expanded: inputs.expandedActivityBatches.has(batchKey),
    });
    activityBatch = null;
    if (model.expandableKey === null) return;
    const block = runnerActivityBatchRowBlock({ model, width: ctx.width });
    if (block === null) return;
    for (const row of block.createRows(0, block.rowCount)) {
      if (row.kind === 'activity-more') {
        actions.set(row.key, { type: 'toggle-activity-batch', key: batchKey });
      }
    }
  };

  for (const section of inputs.sections) {
    if (section.type === 'completed-task') {
      flushActivityBatch();
      continue;
    }
    for (const [index, event] of section.items.entries()) {
      const globalIndex = section.startIndex + index;
      if (event.type === 'runner_call_activity') {
        if (activityBatch !== null && activityBatch.callId === event.callId) {
          activityBatch.events.push(event);
          activityBatch.lastEvent = event;
        } else {
          flushActivityBatch();
          activityBatch = {
            callId: event.callId,
            firstIndex: globalIndex,
            events: [event],
            lastEvent: event,
          };
        }
        continue;
      }
      if (event.type === 'implementer_generate_done' && event.diff) {
        flushActivityBatch();
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
        continue;
      }
      if (!belongsToActivityBatch(event, activityBatch)) flushActivityBatch();
    }
  }
  flushActivityBatch();
  return actions;
}

function belongsToActivityBatch(
  event: EngineEvent,
  activityBatch: RunnerActivityBatch | null,
): boolean {
  if (activityBatch === null) return false;
  return runnerCallId(event) === activityBatch.callId;
}
