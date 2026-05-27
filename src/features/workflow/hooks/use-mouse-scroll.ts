import { useEffect } from 'react';
import { getActiveFilteredStdin, type FilteredStdin } from '../../../lib/terminal/mouse.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import {
  readConversationScrollSnapshot,
  readReviewContentHeight,
} from '../layout.js';

const WHEEL_STEP = 1;

export function wireMouseScroll(filteredStdin: FilteredStdin): () => void {
  return filteredStdin.onMouse((event) => {
    if (routerStore.get().screen !== 'workflow') return;

    const direction = event.type === 'wheel-up' ? -1 : 1;

    const review = reviewStore.get();
    const snapshot = readConversationScrollSnapshot();
    const { contentRect } = snapshot;
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
      const maxOffset = Math.max(0, review.lineCount - visibleHeight);
      const nextOffset = Math.min(
        maxOffset,
        Math.max(0, review.scrollOffset + direction * WHEEL_STEP),
      );
      reviewStore.setScrollOffset(nextOffset);
      return;
    }

    const { renderableCount, totalHeight, maxOffset } = snapshot;
    if (direction < 0) {
      conversationScrollStore.scrollUp({ renderableCount, totalHeight, step: WHEEL_STEP, maxOffset });
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
