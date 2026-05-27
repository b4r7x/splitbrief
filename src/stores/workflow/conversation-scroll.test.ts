import { describe, it, expect, beforeEach } from 'vitest';
import type { Key } from 'ink';
import { handleConversationScroll } from '../../features/workflow/keyboard.js';
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
    conversationScrollStore.toggleDiff(3);
    expect(conversationScrollStore.get().expandedDiffs.has(3)).toBe(true);

    conversationScrollStore.toggleDiff(3);
    expect(conversationScrollStore.get().expandedDiffs.has(3)).toBe(false);

    conversationScrollStore.toggleDiff(1);
    conversationScrollStore.toggleDiff(5);
    const { expandedDiffs } = conversationScrollStore.get();
    expect(expandedDiffs.has(1)).toBe(true);
    expect(expandedDiffs.has(5)).toBe(true);

    conversationScrollStore.scrollUp({ renderableCount: 5, totalHeight: 10, maxOffset: 10 });
    conversationScrollStore.reset();
    const s = conversationScrollStore.get();
    expect(s.scrollOffset).toBe(0);
    expect(s.expandedDiffs.size).toBe(0);
    expect(s.renderableCountAtScroll).toBe(0);
  });
});

describe('handleConversationScroll', () => {
  const base = {
    key: {} as Key,
    renderableCount: 24,
    maxOffset: 9,
    viewportHeight: 12,
    totalHeight: 42,
  };

  it('maps g to the top and G to the bottom conversation scroll actions', () => {
    expect(handleConversationScroll({ ...base, input: 'g' })).toEqual({
      type: 'conversation-scroll-up',
      renderableCount: 24,
      step: 9,
      totalHeight: 42,
      maxOffset: 9,
    });
    expect(handleConversationScroll({ ...base, input: 'G' })).toEqual({
      type: 'conversation-scroll-bottom',
      renderableCount: 24,
    });
  });
});
