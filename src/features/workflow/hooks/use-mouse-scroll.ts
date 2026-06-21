import { useEffect } from 'react';
import {
  getActiveFilteredStdin,
  type FilteredStdin,
} from '../../../lib/terminal/filtered-stdin.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { readConversationScrollSnapshot, readReviewContentHeight } from '../layout/snapshot.js';

const WHEEL_STEP = 1;

export function wireMouseScroll(filteredStdin: FilteredStdin): () => void {
  return filteredStdin.onMouse((event) => {
    if (routerStore.get().screen !== 'workflow') return;
    if (overlayStore.get().active !== 'none') return;

    const direction = event.type === 'wheel-up' ? -1 : 1;

    const review = reviewStore.get();
    const snapshot = readConversationScrollSnapshot();
    const contentRect = review.filePath ? snapshot.contentRect : snapshot.conversationRect;
    if (
      event.x < contentRect.left ||
      event.x > contentRect.right ||
      event.y < contentRect.top ||
      event.y > contentRect.bottom
    ) {
      return;
    }

    if (review.filePath) {
      const visibleHeight = readReviewContentHeight();
      const maxOffset = Math.max(0, review.renderedLineCount - visibleHeight);
      const nextOffset = Math.min(
        maxOffset,
        Math.max(0, review.scrollOffset + direction * WHEEL_STEP),
      );
      reviewStore.setScrollOffset(nextOffset);
      return;
    }

    const { renderableCount, totalHeight, maxOffset } = snapshot;
    if (direction < 0) {
      conversationScrollStore.scrollUp({
        renderableCount,
        totalHeight,
        step: WHEEL_STEP,
        maxOffset,
      });
    } else {
      conversationScrollStore.scrollDown(WHEEL_STEP);
    }
  });
}

export function useMouseScroll(): void {
  useEffect(() => {
    const filteredStdin = getActiveFilteredStdin();
    if (!filteredStdin) return;
    return wireMouseScroll(filteredStdin);
  }, []);
}
