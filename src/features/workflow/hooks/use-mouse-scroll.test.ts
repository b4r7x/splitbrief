import { beforeEach, describe, expect, it } from 'vitest';
import { wireAppMouse } from '../../../app/mouse.js';
import type { FilteredStdin, MouseEvent } from '../../../lib/terminal/filtered-stdin.js';
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
      activate: () => {},
      isPasteActive: () => false,
      disable: () => {},
    } satisfies FilteredStdin,
    emit: (type: 'wheel-up' | 'wheel-down', x = 1, y = 1) =>
      listener?.({
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

describe('wireAppMouse workflow wheel handling', () => {
  beforeEach(() => {
    routerStore.reset();
    reviewStore.reset();
    terminalSizeStore.__testReset({ rows: 20, cols: 80, isSmall: false });
    conversationScrollStore.reset();
    resetWorkflow();
    inputHeightStore.reset();
  });

  it('scrolls the review pane when review mode is open', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    reviewStore.setReviewFile('spec.md', 100);

    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit('wheel-down', 2, 7);
    expect(reviewStore.get().scrollOffset).toBe(1);
    dispose();
  });

  it('scrolls the conversation even when touchpad wheel coordinates are outside the content rectangle', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    eventsStore.__testReset({
      events: Array.from({ length: 20 }, (_, ts) => ({
        type: 'planner_text' as const,
        ts,
        phase: 'specifying' as const,
        text: `event-${ts}`,
      })),
    });

    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit('wheel-up', 2, 1);
    expect(conversationScrollStore.get().scrollOffset).toBe(1);
    dispose();
  });

  it('scrolls the conversation back toward the bottom on wheel-down', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    eventsStore.__testReset({
      events: Array.from({ length: 20 }, (_, ts) => ({
        type: 'planner_text' as const,
        ts,
        phase: 'specifying' as const,
        text: `event-${ts}`,
      })),
    });
    conversationScrollStore.__testReset({
      scrollOffset: 1,
      renderableCountAtScroll: 20,
      heightAtScroll: 20,
    });

    const mock = createMockFilteredStdin();
    const dispose = wireAppMouse(mock.filtered);
    mock.emit('wheel-down', 2, 7);
    expect(conversationScrollStore.get().scrollOffset).toBe(0);
    dispose();
  });
});
