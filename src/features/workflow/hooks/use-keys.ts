import { useInput, type Key } from 'ink';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { getSections } from '../../../stores/workflow/actions.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import { assertNever } from '../../../utils/type-guards.js';
import { findLatestRenderableDiffKey } from '../../../core/sections/event-sections.js';
import { findLatestExpandableActivityBatchKey } from '../conversation-rows/activity-batch-key.js';
import {
  handleWorkflowCtrlChords,
  handleReviewScroll,
  handleConversationScroll,
  type WorkflowKeyAction,
} from '../keyboard.js';
import { readConversationScrollSnapshot, readReviewContentHeight } from '../layout/snapshot.js';

function applyAction(action: WorkflowKeyAction) {
  switch (action.type) {
    case 'none':
      return;
    case 'toggle-sidebar':
      controlsStore.toggleSidebar();
      return;
    case 'toggle-diff':
      conversationScrollStore.toggleDiff(action.key);
      return;
    case 'toggle-activity-batch':
      conversationScrollStore.toggleActivityBatch(action.key);
      return;
    case 'review-scroll':
      reviewStore.setScrollOffset(action.offset);
      return;
    case 'conversation-scroll-up':
      conversationScrollStore.scrollUp({
        renderableCount: action.renderableCount,
        totalHeight: action.totalHeight,
        step: action.step,
        maxOffset: action.maxOffset,
      });
      return;
    case 'conversation-scroll-down':
      conversationScrollStore.scrollDown(action.step);
      return;
    case 'conversation-scroll-bottom':
      conversationScrollStore.scrollToBottom(action.renderableCount);
      return;
    default:
      return assertNever(action);
  }
}

function isConversationScrollKey(key: Key): boolean {
  if (key.shift && (key.upArrow || key.downArrow)) return true;
  if (key.pageUp || key.pageDown) return true;
  return key.home || key.end;
}

function getReviewScrollAction(key: Key): WorkflowKeyAction {
  const review = reviewStore.get();
  if (!review.filePath) return { type: 'none' };
  return handleReviewScroll({
    key,
    reviewScrollOffset: review.scrollOffset,
    reviewLineCount: review.renderedLineCount,
    visibleHeight: readReviewContentHeight(),
  });
}

function getConversationScrollAction(key: Key): WorkflowKeyAction {
  if (!isConversationScrollKey(key)) return { type: 'none' };

  const { maxOffset, renderableCount, totalHeight, viewportHeight } =
    readConversationScrollSnapshot();
  return handleConversationScroll({
    key,
    renderableCount,
    maxOffset,
    viewportHeight,
    totalHeight,
  });
}

export function useWorkflowKeys(isActive: boolean) {
  const [overlay, { isSmall }] = useStores(overlayStore, terminalSizeStore);
  const { active: overlayActive } = overlay;
  const isOpen = overlayActive !== 'none';

  useInput(
    (_input, _key) => {
      overlayStore.close();
    },
    { isActive: isActive && overlayActive === 'cost-drilldown' },
  );

  useInput(
    (input, key) => {
      const sections = getSections();
      const inputMode = controlsStore.get().inputMode;

      if (inputMode === 'normal') {
        const chord = handleWorkflowCtrlChords({
          input,
          key,
          isSmall,
          sections,
          findLatestDiff: findLatestRenderableDiffKey,
          findLatestActivityBatch: findLatestExpandableActivityBatchKey,
        });
        if (chord.type !== 'none') {
          applyAction(chord);
          return;
        }
      }

      const reviewScroll = getReviewScrollAction(key);
      if (reviewScroll.type !== 'none') {
        applyAction(reviewScroll);
        return;
      }

      if (inputMode !== 'normal') return;

      if (key.ctrl && input === 'g') {
        overlayStore.open('cost-drilldown');
        return;
      }

      const scroll = getConversationScrollAction(key);
      if (scroll.type !== 'none') {
        applyAction(scroll);
        return;
      }
    },
    { isActive: isActive && !isOpen },
  );
}
