import { beforeEach, describe, expect, it } from 'vitest';
import type { MouseEvent } from '../../../lib/terminal/filtered-stdin/types.js';
import type { EngineEventOf } from '../../../engine/events/types.js';
import { handleWorkflowMouseWheel } from './use-mouse-scroll.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { completionStore } from '../../../stores/ui/completion.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { inputHeightStore } from '../../../stores/ui/input-height.js';
import { readConversationScrollSnapshot, readReviewContentHeight } from '../layout/snapshot.js';

const VIEWPORTS = [
  { label: '120x40', cols: 120, rows: 40 },
  { label: '80x24', cols: 80, rows: 24 },
  { label: '60x18', cols: 60, rows: 18 },
];

function wheelEvent(type: 'wheel-up' | 'wheel-down', x = 1, y = 1): MouseEvent {
  return {
    type,
    x,
    y,
    button: type === 'wheel-up' ? 64 : 65,
    shift: false,
    meta: false,
    ctrl: false,
  };
}

function seedLongConversation(): void {
  const events: EngineEventOf<'planner_text'>[] = Array.from({ length: 80 }, (_, ts) => ({
    type: 'planner_text',
    ts,
    phase: 'specifying',
    text: `event-${ts}`,
  }));
  eventsStore.__testReset({
    events,
  });
}

describe('handleWorkflowMouseWheel', () => {
  beforeEach(() => {
    resetAllStores();
    completionStore.reset();
    terminalSizeStore.__testReset({ cols: 80, rows: 24 });
    inputHeightStore.__testReset({ rows: 3 });
  });

  it('scrolls the review pane when review mode is open', () => {
    controlsStore.setInputMode('review');
    reviewStore.setReviewFile('spec.md', 100);

    handleWorkflowMouseWheel(wheelEvent('wheel-down', 2, 7));
    expect(reviewStore.get().scrollOffset).toBe(1);
  });

  it('routes wheel input to the projected pane without moving its sibling', () => {
    seedLongConversation();
    reviewStore.setReviewFile('spec.md', 100);

    handleWorkflowMouseWheel(wheelEvent('wheel-up', 2, 1));
    expect(conversationScrollStore.get().scrollOffset).toBe(1);
    expect(reviewStore.get().scrollOffset).toBe(0);

    controlsStore.setInputMode('review');
    handleWorkflowMouseWheel(wheelEvent('wheel-down', 2, 7));
    expect(reviewStore.get().scrollOffset).toBe(1);
    expect(conversationScrollStore.get().scrollOffset).toBe(1);

    reviewStore.clearReview();
    handleWorkflowMouseWheel(wheelEvent('wheel-up', 2, 7));
    expect(conversationScrollStore.get().scrollOffset).toBe(1);
  });

  it.each(VIEWPORTS)('$label wheel input starts from canonical clamped offsets', ({
    cols,
    rows,
  }) => {
    terminalSizeStore.__testReset({ cols, rows });
    inputHeightStore.__testReset({ rows: 3 });
    seedLongConversation();

    const initialConversation = readConversationScrollSnapshot();
    expect(initialConversation.maxOffset).toBeGreaterThan(1);
    conversationScrollStore.__testReset({
      scrollOffset: initialConversation.maxOffset + 10,
    });
    const visibleConversation = readConversationScrollSnapshot();
    reviewStore.setScrollOffset(7);

    handleWorkflowMouseWheel(wheelEvent('wheel-down', 2, 7));

    expect(readConversationScrollSnapshot().scrollOffset).toBe(visibleConversation.maxOffset - 1);
    expect(reviewStore.get().scrollOffset).toBe(7);

    const conversationOffset = conversationScrollStore.get().scrollOffset;
    reviewStore.setReviewFile('spec.md', 100);
    controlsStore.setInputMode('review');
    const reviewMaxOffset = 100 - readReviewContentHeight();
    reviewStore.setScrollOffset(reviewMaxOffset + 10);

    handleWorkflowMouseWheel(wheelEvent('wheel-up', 2, 7));

    expect(reviewStore.get().scrollOffset).toBe(reviewMaxOffset - 1);
    expect(conversationScrollStore.get().scrollOffset).toBe(conversationOffset);
  });

  it('completion owns wheel input until its menu closes', () => {
    seedLongConversation();
    completionStore.setOpen(true);

    handleWorkflowMouseWheel(wheelEvent('wheel-up', 2, 7));
    expect(conversationScrollStore.get().scrollOffset).toBe(0);

    completionStore.setOpen(false);
    handleWorkflowMouseWheel(wheelEvent('wheel-up', 2, 7));
    expect(conversationScrollStore.get().scrollOffset).toBe(1);
  });
});
