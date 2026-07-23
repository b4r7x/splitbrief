import type { MouseEvent } from '../../../lib/terminal/filtered-stdin/types.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../../../stores/cost-approval/prompt.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { readConversationScrollSnapshot, readReviewContentHeight } from '../layout/snapshot.js';
import { clamp } from '../../../utils/math.js';

const WHEEL_STEP = 1;

export function promptOwnsInput(): boolean {
  return (
    approvalPromptStore.get().status === 'pending' ||
    costApprovalStore.get().status === 'pending' ||
    controlsStore.get().inputMode === 'question'
  );
}

export function handleWorkflowMouseWheel(event: MouseEvent): void {
  if (event.type !== 'wheel-up' && event.type !== 'wheel-down') return;

  const direction = event.type === 'wheel-up' ? -1 : 1;

  const review = reviewStore.get();

  if (review.filePath) {
    const visibleHeight = readReviewContentHeight();
    const maxOffset = Math.max(0, review.renderedLineCount - visibleHeight);
    const nextOffset = clamp(review.scrollOffset + direction * WHEEL_STEP, 0, maxOffset);
    reviewStore.setScrollOffset(nextOffset);
    return;
  }

  const snapshot = readConversationScrollSnapshot();
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
}
