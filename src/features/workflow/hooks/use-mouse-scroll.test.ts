import { beforeEach, describe, expect, it } from 'vitest';
import { wireMouseScroll } from './use-mouse-scroll.js';
import type { FilteredStdin, MouseEvent } from '../../../lib/terminal/mouse.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { resetWorkflow } from '../../../stores/workflow/actions.js';
import { inputHeightStore } from '../../../stores/ui/input-height.js';

function createMockFilteredStdin() {
  let listener: ((event: MouseEvent) => void) | undefined;
  return {
    filtered: {
      stdin: process.stdin as unknown as NodeJS.ReadStream,
      onMouse: (next: (event: MouseEvent) => void) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      disable: () => {},
    } satisfies FilteredStdin,
    emit: (type: 'wheel-up' | 'wheel-down', x = 1, y = 1) => listener?.({
      type,
      x,
      y,
      button: type === 'wheel-up' ? 64 : 65,
      shift: false,
      meta: false,
      ctrl: false,
    }),
  };
}

describe('wireMouseScroll', () => {
  beforeEach(() => {
    routerStore.reset();
    reviewStore.reset();
    terminalSizeStore.set({ rows: 20, cols: 80, isSmall: false });
    conversationScrollStore.reset();
    resetWorkflow();
    inputHeightStore.reset();
  });

  it('ignores wheel input outside the workflow screen', () => {
    const mock = createMockFilteredStdin();
    const dispose = wireMouseScroll(mock.filtered);
    mock.emit('wheel-down', 2, 4);
    expect(conversationScrollStore.get().scrollOffset).toBe(0);
    dispose();
  });

  it('scrolls the review pane when review mode is open', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    reviewStore.setReviewFile('spec.md', 100);

    const mock = createMockFilteredStdin();
    const dispose = wireMouseScroll(mock.filtered);
    mock.emit('wheel-down', 2, 4);
    expect(reviewStore.get().scrollOffset).toBe(1);
    dispose();
  });

  it('ignores wheel input outside the conversation rectangle', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });

    const mock = createMockFilteredStdin();
    const dispose = wireMouseScroll(mock.filtered);
    mock.emit('wheel-down', 2, 1);
    expect(conversationScrollStore.get().scrollOffset).toBe(0);
    dispose();
  });

  it('scrolls the conversation when the wheel is inside the content rectangle', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    eventsStore.set({
      events: Array.from({ length: 20 }, (_, ts) => ({
        type: 'planner-text' as const,
        ts,
        text: `event-${ts}`,
      })),
    });

    const mock = createMockFilteredStdin();
    const dispose = wireMouseScroll(mock.filtered);
    mock.emit('wheel-up', 2, 4);
    expect(conversationScrollStore.get().scrollOffset).toBe(1);
    dispose();
  });
});
