import type { RenderableConversationItem } from './renderable-conversation.js';

interface ViewportTrimResult {
  visibleItems: RenderableConversationItem[];
  trimTop: number;
}

export function trimRenderableItemsToViewport(
  items: RenderableConversationItem[],
  totalHeight: number,
  windowStart: number,
  windowEnd: number,
): ViewportTrimResult {
  if (items.length === 0) {
    return { visibleItems: [], trimTop: 0 };
  }
  if (windowStart === 0 && windowEnd >= totalHeight) {
    return { visibleItems: items, trimTop: 0 };
  }
  const visibleItems: RenderableConversationItem[] = [];
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
