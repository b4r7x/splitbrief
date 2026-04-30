import type { DynamicSection, Section } from './event-sections.js';
import type { LayoutEvent } from './event-types.js';
import { computeScrollMaxOffset } from './scroll-window.js';
import {
  estimateRenderableConversationHeight,
  getRenderableConversationItems,
  type RenderableConversationItem,
} from './renderable-conversation.js';

export interface ConversationScrollComputation<TEvent extends LayoutEvent = LayoutEvent> {
  maxOffset: number;
  newEventCount: number;
  renderableCount: number;
  renderableItems: RenderableConversationItem<TEvent>[];
  scrollOffset: number;
  totalDynamicHeight: number;
  viewportHeight: number;
}

interface ConversationScrollInputs<TEvent extends LayoutEvent = LayoutEvent> {
  sections: Section<TEvent>[];
  expandedDiffs: Set<number>;
  cols: number;
  viewportHeight: number;
  rawScrollOffset: number;
  renderableCountAtScroll: number;
  heightAtScroll: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

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

export function computeConversationScroll<TEvent extends LayoutEvent>(
  inputs: ConversationScrollInputs<TEvent>,
): ConversationScrollComputation<TEvent> {
  const dynamicSections = inputs.sections.filter(
    (section): section is DynamicSection<TEvent> => section.type !== 'completed-task',
  );
  const renderableItems = getRenderableConversationItems(
    dynamicSections,
    inputs.expandedDiffs,
    inputs.cols,
    inputs.viewportHeight,
  );
  const renderableCount = renderableItems.length;
  const newEventCount =
    inputs.rawScrollOffset > 0
      ? Math.max(0, renderableCount - inputs.renderableCountAtScroll)
      : 0;
  const totalDynamicHeight = estimateRenderableConversationHeight(renderableItems);
  const maxOffset = computeScrollMaxOffset(
    totalDynamicHeight,
    inputs.viewportHeight,
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
    renderableItems,
    scrollOffset,
    totalDynamicHeight,
    viewportHeight: inputs.viewportHeight,
  };
}
