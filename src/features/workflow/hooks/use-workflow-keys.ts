import { useInput, type Key } from 'ink';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { getSections } from '../../../stores/workflow/actions.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { useStores } from '../../../stores/use-stores.js';
import { assertNever } from '../../../utils/type-guards.js';
import { findLatestRenderableDiffEventIndex } from '../../../core/sections/event-sections.js';
import {
  handleWorkflowEscape,
  handleWorkflowCtrlChords,
  handleReviewScroll,
  handleConversationScroll,
  type WorkflowKeyAction,
} from '../keyboard.js';
import { readConversationScrollSnapshot, readReviewContentHeight } from '../layout.js';

function applyAction(action: WorkflowKeyAction) {
  switch (action.type) {
    case 'none':
      return;
    case 'navigate-home':
      routerStore.navigate({ to: 'home' });
      return;
    case 'toggle-sidebar':
      controlsStore.toggleSidebar();
      return;
    case 'toggle-diff':
      conversationScrollStore.toggleDiff(action.index);
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

function getWorkflowScrollAction(input: string, key: Key): WorkflowKeyAction {
  const review = reviewStore.get();

  if (review.filePath) {
    const visibleHeight = readReviewContentHeight();
    return handleReviewScroll({
      input,
      key,
      reviewScrollOffset: review.scrollOffset,
      reviewLineCount: review.lineCount,
      visibleHeight,
    });
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
      if (key.escape) {
        const { cancelled } = lifecycleStore.get();
        const action = handleWorkflowEscape(key, cancelled);
        if (action.type !== 'none') {
          applyAction(action);
          return;
        }
      }

      const sections = getSections();

      const chord = handleWorkflowCtrlChords({
        input,
        key,
        isSmall,
        sections,
        findLatestDiff: findLatestRenderableDiffEventIndex,
      });
      if (chord.type !== 'none') {
        applyAction(chord);
        return;
      }

      if (controlsStore.get().inputMode !== 'normal') return;

      if (input === '$') {
        overlayStore.open('cost-drilldown');
        return;
      }

      const scroll = getWorkflowScrollAction(input, key);
      if (scroll.type !== 'none') {
        applyAction(scroll);
        return;
      }
    },
    { isActive: isActive && !isOpen },
  );
}
