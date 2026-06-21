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
import { activityBatchKey } from './activity-batch-key.js';
import { buildActivityBatchViewModel } from './activity-batch-model.js';
import { eventRowBlock, isPlannerTextRenderedAsMarkdown } from './event-rows.js';
import { runnerActivityBatchRowBlock } from './activity-rows.js';
import {
  beginMarkdownConversationRowsProjectionPass,
  markdownConversationRowsCacheKey,
} from './markdown-rows.js';

const MIN_ROW_WIDTH = 1;

type RunnerActivityEvent = EngineEventOf<'runner_call_activity'>;

interface RunnerActivityBatch {
  callId: string;
  firstIndex: number;
  events: RunnerActivityEvent[];
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
  const endMarkdownProjectionPass = beginMarkdownConversationRowsProjectionPass(
    markdownProjectionCacheKeys(inputs.sections, ctx.width),
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

  const appendBlock = (block: ConversationRowBlock, globalIndex: number): void => {
    if (block.rowCount === 0) return;
    if (hasRenderableBlock) {
      blocks.push({
        key: `spacer-${globalIndex}`,
        rowCount: 1,
        renderableUnits: 0,
        createRows: (windowStart, windowEnd) =>
          windowStart === 0 && windowEnd > 0 ? [blankRow(`spacer-${globalIndex}`)] : [],
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
    const model = buildActivityBatchViewModel({
      events,
      batchKey,
      expanded: inputs.expandedActivityBatches.has(batchKey),
    });
    const width = ctx.width;
    const block = runnerActivityBatchRowBlock({ model, width });
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
        } else {
          flushActivityBatch();
          activityBatch = { callId: event.callId, firstIndex: globalIndex, events: [event] };
        }
        continue;
      }

      const block = eventRowBlock({
        event,
        globalIndex,
        ctx,
        expanded: inputs.expandedDiffs.has(diffEventKey(event)),
      });
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

function belongsToActivityBatch(
  event: EngineEvent,
  activityBatch: RunnerActivityBatch | null,
): boolean {
  if (activityBatch === null) return false;
  const callId = runnerCallId(event);
  return callId === activityBatch.callId;
}

function runnerCallId(event: EngineEvent): string | null {
  switch (event.type) {
    case 'runner_call_started':
    case 'runner_call_text_delta':
    case 'runner_call_usage':
    case 'runner_call_tool_use':
    case 'runner_call_activity':
    case 'runner_call_session_id':
    case 'runner_call_artifact':
    case 'runner_call_warning':
    case 'runner_call_error':
    case 'runner_call_completed':
      return event.callId;
    default:
      return null;
  }
}
