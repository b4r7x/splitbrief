import type { LayoutEvent } from './event-types.js';
import type { RenderableConversationItem } from './renderable-conversation.js';

interface ViewportTrimResult<TEvent extends LayoutEvent = LayoutEvent> {
  visibleItems: RenderableConversationItem<TEvent>[];
  trimTop: number;
}

export function trimRenderableItemsToViewport<TEvent extends LayoutEvent>(
  items: RenderableConversationItem<TEvent>[],
  totalHeight: number,
  windowStart: number,
  windowEnd: number,
): ViewportTrimResult<TEvent> {
  if (items.length === 0) {
    return { visibleItems: [], trimTop: 0 };
  }
  if (windowStart === 0 && windowEnd >= totalHeight) {
    return { visibleItems: items, trimTop: 0 };
  }
  const visibleItems: RenderableConversationItem<TEvent>[] = [];
  let trimTop = 0;
  let itemTop = 0;

  for (const item of items) {
    const blockHeight = item.height + (item.leadingSpacer ? 1 : 0);
    const itemBottom = itemTop + blockHeight;
    if (itemBottom <= windowStart) {
      itemTop = itemBottom;
      continue;
    }
    if (itemTop >= windowEnd) {
      break;
    }
    if (visibleItems.length === 0) {
      trimTop = Math.max(0, windowStart - itemTop);
    }
    visibleItems.push(item);
    itemTop = itemBottom;
  }

  return { visibleItems, trimTop };
}
