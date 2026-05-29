import { getCompletedTaskSummaryRows } from '../../../core/sections/completed-task-summary-rows.js';
import { clamp } from '../../../utils/math.js';
import { computeScrollMaxOffset } from '../layout/scroll-window.js';
import { buildConversationRows } from './build.js';
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
  const { rows, renderableCount } = buildConversationRows({
    sections: inputs.sections,
    expandedDiffs: inputs.expandedDiffs,
    cols: inputs.cols,
    viewportHeight: scrollViewportHeight,
    streaming: inputs.streaming,
  });
  const newEventCount =
    inputs.rawScrollOffset > 0 ? Math.max(0, renderableCount - inputs.renderableCountAtScroll) : 0;
  const totalDynamicHeight = rows.length;
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

  return {
    maxOffset,
    newEventCount,
    renderableCount,
    rows,
    scrollOffset,
    totalDynamicHeight,
    viewportHeight: scrollViewportHeight,
  };
}
