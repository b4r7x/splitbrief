import { getCompletedTaskSummaryRows } from '../../../core/sections/completed-task-summary-rows.js';
import { clamp } from '../../../utils/math.js';
import { computeScrollMaxOffset, getScrollWindowState } from '../layout/scroll-window.js';
import {
  getConversationRowsProjection,
  getConversationRowsWindowProjection,
} from './projection-cache.js';
import type { ConversationRowScrollComputation, ConversationRowScrollInputs } from './types.js';

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
  const renderableCount = projection.renderableCount;
  const newEventCount =
    inputs.rawScrollOffset > 0 ? Math.max(0, renderableCount - inputs.renderableCountAtScroll) : 0;
  const totalDynamicHeight = projection.totalRows;
  const maxOffset = computeScrollMaxOffset(
    totalDynamicHeight,
    scrollViewportHeight,
    newEventCount > 0,
  );
  const scrollOffset = computeAnchoredScrollOffset({
    rawScrollOffset: inputs.rawScrollOffset,
    heightAtScroll: inputs.heightAtScroll,
    totalDynamicHeight,
    maxOffset,
  });
  const windowState = getScrollWindowState({
    totalHeight: totalDynamicHeight,
    viewportHeight: scrollViewportHeight,
    scrollOffset,
    hasNewEvents: newEventCount > 0,
  });
  const windowProjection = getConversationRowsWindowProjection({
    ...projectionInput,
    windowStart: windowState.windowStart,
    windowEnd: windowState.windowEnd,
  });

  return {
    maxOffset,
    newEventCount,
    renderableCount,
    rows: windowProjection.rows,
    scrollOffset,
    totalDynamicHeight,
    viewportHeight: scrollViewportHeight,
    windowEnd: windowState.windowEnd,
    windowStart: windowState.windowStart,
  };
}
