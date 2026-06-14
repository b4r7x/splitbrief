import { describe, it, expect, beforeEach } from 'vitest';
import { conversationScrollStore } from './conversation-scroll.js';

describe('conversationScrollStore', () => {
  beforeEach(() => {
    conversationScrollStore.reset();
  });

  it('scroll up, clamp, down, to-bottom flow', () => {
    conversationScrollStore.scrollUp({ renderableCount: 7, totalHeight: 10, maxOffset: 10 });
    expect(conversationScrollStore.get().scrollOffset).toBe(1);
    expect(conversationScrollStore.get().renderableCountAtScroll).toBe(7);

    conversationScrollStore.scrollUp({ renderableCount: 15, totalHeight: 10, maxOffset: 10 });
    expect(conversationScrollStore.get().renderableCountAtScroll).toBe(7);

    conversationScrollStore.scrollUp({ renderableCount: 3, totalHeight: 2, maxOffset: 2 });
    conversationScrollStore.scrollUp({ renderableCount: 3, totalHeight: 2, maxOffset: 2 });
    conversationScrollStore.scrollUp({ renderableCount: 3, totalHeight: 2, maxOffset: 2 });
    expect(conversationScrollStore.get().scrollOffset).toBe(2);

    conversationScrollStore.scrollDown();
    expect(conversationScrollStore.get().scrollOffset).toBe(1);

    conversationScrollStore.scrollDown();
    expect(conversationScrollStore.get().scrollOffset).toBe(0);
    expect(conversationScrollStore.get().renderableCountAtScroll).toBe(0);

    conversationScrollStore.scrollDown();
    expect(conversationScrollStore.get().scrollOffset).toBe(0);

    conversationScrollStore.scrollUp({ renderableCount: 10, totalHeight: 10, maxOffset: 10 });
    conversationScrollStore.scrollToBottom(42);
    expect(conversationScrollStore.get().scrollOffset).toBe(0);
    expect(conversationScrollStore.get().renderableCountAtScroll).toBe(42);
  });

  it('toggle diffs and reset flow', () => {
    conversationScrollStore.toggleDiff('implementer_generate_done:3');
    expect(conversationScrollStore.get().expandedDiffs.has('implementer_generate_done:3')).toBe(
      true,
    );

    conversationScrollStore.toggleDiff('implementer_generate_done:3');
    expect(conversationScrollStore.get().expandedDiffs.has('implementer_generate_done:3')).toBe(
      false,
    );

    conversationScrollStore.toggleDiff('implementer_generate_done:1');
    conversationScrollStore.toggleDiff('implementer_generate_done:5');
    const { expandedDiffs } = conversationScrollStore.get();
    expect(expandedDiffs.has('implementer_generate_done:1')).toBe(true);
    expect(expandedDiffs.has('implementer_generate_done:5')).toBe(true);

    conversationScrollStore.scrollUp({ renderableCount: 5, totalHeight: 10, maxOffset: 10 });
    conversationScrollStore.reset();
    const s = conversationScrollStore.get();
    expect(s.scrollOffset).toBe(0);
    expect(s.expandedDiffs.size).toBe(0);
    expect(s.renderableCountAtScroll).toBe(0);
  });
});
