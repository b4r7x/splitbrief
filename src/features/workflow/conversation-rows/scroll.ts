import { getCompletedTaskSummaryRows } from '../../../core/sections/completed-task-summary-rows.js';
import { clamp } from '../../../utils/math.js';
import { computeScrollMaxOffset, getScrollWindowState } from '../layout/scroll-window.js';
import {
  getConversationRowsProjection,
  getConversationRowsWindowProjection,
} from './projection-cache.js';
import type {
  ConversationRowsProjection,
  ConversationRowScrollComputation,
  ConversationRowScrollInputs,
} from './types.js';

interface AnchoredScrollOffsetInput {
  rawScrollOffset: number;
  heightAtScroll: number;
  totalDynamicHeight: number;
  maxOffset: number;
}

function computeAnchoredScrollOffset(input: AnchoredScrollOffsetInput): number {
  const { rawScrollOffset, heightAtScroll, totalDynamicHeight, maxOffset } = input;
  if (rawScrollOffset <= 0 || heightAtScroll <= 0) {
    return clamp(rawScrollOffset, 0, maxOffset);
  }

  const heightDelta = totalDynamicHeight - heightAtScroll;
  return clamp(rawScrollOffset + heightDelta, 0, maxOffset);
}

function findLastActiveRowKey(blocks: ConversationRowsProjection['blocks']): string | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const activeRowKey = blocks[i]?.activeRowKey;
    if (activeRowKey !== undefined) return activeRowKey;
  }
  return null;
}

export function computeConversationRowsWindowFromProjection(input: {
  projection: ConversationRowsProjection;
  viewportHeight: number;
  rawScrollOffset: number;
  renderableCountAtScroll: number;
  heightAtScroll: number;
}): Omit<ConversationRowScrollComputation, 'viewportHeight'> {
  const { projection, viewportHeight } = input;
  const renderableCount = projection.renderableCount;
  const newEventCount =
    input.rawScrollOffset > 0 ? Math.max(0, renderableCount - input.renderableCountAtScroll) : 0;
  const totalDynamicHeight = projection.totalRows;
  const maxOffset = computeScrollMaxOffset({ totalHeight: totalDynamicHeight, viewportHeight });
  const scrollOffset = computeAnchoredScrollOffset({
    rawScrollOffset: input.rawScrollOffset,
    heightAtScroll: input.heightAtScroll,
    totalDynamicHeight,
    maxOffset,
  });
  const windowState = getScrollWindowState({
    totalHeight: totalDynamicHeight,
    viewportHeight,
    scrollOffset,
  });
  const windowProjection = getConversationRowsWindowProjection({
    projection,
    windowStart: windowState.windowStart,
    windowEnd: windowState.windowEnd,
  });

  return {
    activeRowKey: findLastActiveRowKey(projection.blocks),
    maxOffset,
    newEventCount,
    renderableCount,
    rows: windowProjection.rows,
    scrollOffset,
    totalDynamicHeight,
    windowEnd: windowState.windowEnd,
    windowStart: windowState.windowStart,
  };
}

export function computeConversationRowScroll(
  inputs: ConversationRowScrollInputs,
): ConversationRowScrollComputation {
  const scrollViewportHeight = Math.max(
    0,
    inputs.viewportHeight - getCompletedTaskSummaryRows(inputs.sections, inputs.viewportHeight),
  );
  const projectionInput = {
    sections: inputs.sections,
    expandedDiffs: inputs.expandedDiffs,
    expandedActivityBatches: inputs.expandedActivityBatches,
    cols: inputs.cols,
    viewportHeight: scrollViewportHeight,
    streaming: inputs.streaming,
  };
  const projection = getConversationRowsProjection(projectionInput);
  const windowResult = computeConversationRowsWindowFromProjection({
    projection,
    viewportHeight: scrollViewportHeight,
    rawScrollOffset: inputs.rawScrollOffset,
    renderableCountAtScroll: inputs.renderableCountAtScroll,
    heightAtScroll: inputs.heightAtScroll,
  });

  return {
    ...windowResult,
    viewportHeight: scrollViewportHeight,
  };
}
