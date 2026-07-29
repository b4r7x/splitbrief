import { useInput, type Key } from 'ink';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { completionStore } from '../../../stores/ui/completion.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { getSections } from '../../../stores/workflow/actions/sections.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { useStores } from '../../../stores/use-stores.js';
import { assertNever } from '../../../utils/type-guards.js';
import { clamp } from '../../../utils/math.js';
import { findLatestRenderableDiffKey } from '../../../core/sections/event-sections.js';
import { resolveScrollKey } from '../../../core/keybindings/scroll.js';
import { findLatestExpandableActivityBatchKey } from '../conversation-rows/activity-batch-key.js';
import {
  handleWorkflowCtrlChords,
  handleReviewScroll,
  handleConversationScroll,
  type WorkflowKeyAction,
} from '../keyboard.js';
import { readConversationScrollSnapshot, readReviewContentHeight } from '../layout/snapshot.js';
import type { KeyAttachState } from '../../../core/keybindings/resolver.js';
import type { InputMode, OverlayType } from '../../../core/navigation/types.js';

function applyAction(action: WorkflowKeyAction) {
  switch (action.type) {
    case 'none':
      return;
    case 'toggle-diff':
      conversationScrollStore.toggleDiff(action.key);
      return;
    case 'toggle-activity-batch':
      conversationScrollStore.toggleActivityBatch(action.key);
      return;
    case 'open-cost-drilldown':
      overlayStore.open('cost-drilldown');
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
      {
        const visibleOffset = readConversationScrollSnapshot().scrollOffset;
        const storedOffset = conversationScrollStore.get().scrollOffset;
        conversationScrollStore.scrollDown(action.step + Math.max(0, storedOffset - visibleOffset));
      }
      return;
    case 'conversation-scroll-bottom':
      conversationScrollStore.scrollToBottom(action.renderableCount);
      return;
    default:
      return assertNever(action);
  }
}

interface ReviewScrollContext {
  inputMode: InputMode;
  overlay: OverlayType;
  attachState: KeyAttachState;
  composerFocus: boolean;
}

function getReviewScrollAction(
  input: string,
  key: Key,
  context: ReviewScrollContext,
): WorkflowKeyAction {
  const review = reviewStore.get();
  if (!review.filePath) return { type: 'none' };
  const visibleHeight = readReviewContentHeight();
  const maxOffset = Math.max(0, review.renderedLineCount - visibleHeight);
  return handleReviewScroll({
    input,
    key,
    inputMode: context.inputMode,
    overlay: context.overlay,
    attachState: context.attachState,
    composerFocus: context.composerFocus,
    focus: context.inputMode === 'review' ? 'review' : 'workflow',
    reviewScrollOffset: clamp(review.scrollOffset, 0, maxOffset),
    reviewLineCount: review.renderedLineCount,
    visibleHeight,
  });
}

function getConversationScrollAction(
  input: string,
  key: Key,
  composerFocus: boolean,
): WorkflowKeyAction {
  if (resolveScrollKey({ input, key, lineKeys: 'shifted' }) === null) {
    return { type: 'none' };
  }

  const { maxOffset, renderableCount, totalHeight, viewportHeight } =
    readConversationScrollSnapshot();
  return handleConversationScroll({
    input,
    key,
    renderableCount,
    maxOffset,
    viewportHeight,
    totalHeight,
    composerFocus,
  });
}

export function useWorkflowKeys({ isActive }: { isActive: boolean }) {
  const [overlay, route, completion] = useStores(overlayStore, routerStore, completionStore);
  const { active: overlayActive } = overlay;
  const isOpen = overlayActive !== 'none';
  const isAttachedClient = route.screen === 'workflow' && route.attach !== undefined;

  useInput(
    (input, key) => {
      const sections = getSections();
      const inputMode = controlsStore.get().inputMode;
      const composerFocus = inputMode === 'normal';
      const attachState = isAttachedClient ? 'attached' : 'local';

      if (inputMode === 'normal') {
        const chord = handleWorkflowCtrlChords({
          input,
          key,
          inputMode,
          overlay: overlayActive,
          attachState,
          composerFocus,
          sections,
          findLatestDiff: findLatestRenderableDiffKey,
          findLatestActivityBatch: findLatestExpandableActivityBatchKey,
        });
        if (chord.type !== 'none') {
          applyAction(chord);
          return;
        }
      }

      const reviewScroll = getReviewScrollAction(input, key, {
        inputMode,
        overlay: overlayActive,
        attachState,
        composerFocus,
      });
      if (reviewScroll.type !== 'none') {
        applyAction(reviewScroll);
        return;
      }

      if (inputMode !== 'normal') return;

      const scroll = getConversationScrollAction(input, key, composerFocus);
      if (scroll.type !== 'none') {
        applyAction(scroll);
        return;
      }
    },
    { isActive: isActive && !isOpen && !completion.open },
  );
}
