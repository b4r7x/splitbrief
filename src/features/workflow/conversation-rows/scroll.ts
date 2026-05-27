import { getCompletedTaskSummaryRows } from '../../../core/layout/completed-task-summary-rows.js';
import { clamp } from '../../../core/layout/math.js';
import { computeScrollMaxOffset } from '../../../core/layout/scroll-window.js';
import { buildConversationRows } from './build.js';
import type { ConversationRowScrollComputation, ConversationRowScrollInputs } from './types.js';

function computeAnchoredScrollOffset(
  rawScrollOffset: number,
  heightAtScroll: number,
  totalDynamicHeight: number,
  maxOffset: number,
): number {
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
    inputs.rawScrollOffset > 0
      ? Math.max(0, renderableCount - inputs.renderableCountAtScroll)
      : 0;
  const totalDynamicHeight = rows.length;
  const maxOffset = computeScrollMaxOffset(
    totalDynamicHeight,
    scrollViewportHeight,
    newEventCount > 0,
  );
  const scrollOffset = computeAnchoredScrollOffset(
    inputs.rawScrollOffset,
    inputs.heightAtScroll,
    totalDynamicHeight,
    maxOffset,
  );

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
