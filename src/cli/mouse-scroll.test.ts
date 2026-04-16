import { beforeEach, describe, expect, it } from 'vitest';
import { wireWorkflowMouseScroll } from './mouse-scroll.js';
import type { FilteredStdin, MouseEvent } from '../utils/mouse.js';
import { routerStore } from '../stores/router.js';
import { reviewStore } from '../stores/review.js';
import { terminalSizeStore } from '../stores/terminal-size.js';
import { conversationScrollStore } from '../stores/conversation-scroll.js';
import { workflowStore } from '../stores/workflow.js';
import { inputHeightStore } from '../stores/input-height.js';

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

describe('wireWorkflowMouseScroll', () => {
  beforeEach(() => {
    routerStore.reset();
    reviewStore.reset();
    terminalSizeStore.reset({ rows: 20, cols: 80, isSmall: false });
    conversationScrollStore.reset();
    workflowStore.reset();
    inputHeightStore.reset();
  });

  it('ignores wheel input outside the workflow screen', () => {
    const mock = createMockFilteredStdin();
    const dispose = wireWorkflowMouseScroll(mock.filtered);
    mock.emit('wheel-down', 2, 4);
    expect(conversationScrollStore.get().scrollOffset).toBe(0);
    dispose();
  });

  it('scrolls the review pane when review mode is open', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    reviewStore.setReviewFile('spec.md', 100);

    const mock = createMockFilteredStdin();
    const dispose = wireWorkflowMouseScroll(mock.filtered);
    mock.emit('wheel-down', 2, 4);
    expect(reviewStore.get().scrollOffset).toBe(1);
    dispose();
  });

  it('ignores wheel input outside the conversation rectangle', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });

    const mock = createMockFilteredStdin();
    const dispose = wireWorkflowMouseScroll(mock.filtered);
    mock.emit('wheel-down', 2, 1);
    expect(conversationScrollStore.get().scrollOffset).toBe(0);
    dispose();
  });

  it('scrolls the conversation when the wheel is inside the content rectangle', () => {
    routerStore.init({ screen: 'workflow', feature: 'feat' });
    workflowStore.reset({
      ...workflowStore.get(),
      sidebarVisible: false,
      sections: [{
        type: 'events',
        startIndex: 0,
        items: Array.from({ length: 20 }, (_, ts) => ({
          type: 'planner-text' as const,
          ts,
          text: `event-${ts}`,
        })),
      }],
    });

    const mock = createMockFilteredStdin();
    const dispose = wireWorkflowMouseScroll(mock.filtered);
    mock.emit('wheel-up', 2, 4);
    expect(conversationScrollStore.get().scrollOffset).toBe(1);
    dispose();
  });
});
