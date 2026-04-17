import { describe, it, expect, beforeEach } from 'vitest';
import { conversationScrollStore } from './conversation-scroll.js';

describe('conversationScrollStore', () => {
  beforeEach(() => {
    conversationScrollStore.reset();
  });

  describe('scrollUp', () => {
    it('increments scrollOffset', () => {
      conversationScrollStore.scrollUp({ renderableCount: 10, totalHeight: 10 });
      expect(conversationScrollStore.get().scrollOffset).toBe(1);
    });

    it('clamps to totalHeight', () => {
      conversationScrollStore.scrollUp({ renderableCount: 3, totalHeight: 2 });
      conversationScrollStore.scrollUp({ renderableCount: 3, totalHeight: 2 });
      conversationScrollStore.scrollUp({ renderableCount: 3, totalHeight: 2 });
      expect(conversationScrollStore.get().scrollOffset).toBe(2);
    });

    it('captures renderableCount when scrolling from 0 for the first time', () => {
      conversationScrollStore.scrollUp({ renderableCount: 7, totalHeight: 10 });
      expect(conversationScrollStore.get().renderableCountAtScroll).toBe(7);
    });

    it('does not update renderableCountAtScroll on subsequent scrollUp calls', () => {
      conversationScrollStore.scrollUp({ renderableCount: 7, totalHeight: 10 });
      conversationScrollStore.scrollUp({ renderableCount: 15, totalHeight: 10 });
      expect(conversationScrollStore.get().renderableCountAtScroll).toBe(7);
    });
  });

  describe('scrollDown', () => {
    it('decrements scrollOffset', () => {
      conversationScrollStore.scrollUp({ renderableCount: 10, totalHeight: 10 });
      conversationScrollStore.scrollUp({ renderableCount: 10, totalHeight: 10 });
      conversationScrollStore.scrollDown();
      expect(conversationScrollStore.get().scrollOffset).toBe(1);
    });

    it('clamps to 0', () => {
      conversationScrollStore.scrollDown();
      expect(conversationScrollStore.get().scrollOffset).toBe(0);
    });

    it('resets renderableCountAtScroll to 0 when reaching bottom', () => {
      conversationScrollStore.scrollUp({ renderableCount: 5, totalHeight: 10 });
      conversationScrollStore.scrollDown();
      expect(conversationScrollStore.get().scrollOffset).toBe(0);
      expect(conversationScrollStore.get().renderableCountAtScroll).toBe(0);
    });
  });

  describe('scrollToBottom', () => {
    it('sets scrollOffset to 0', () => {
      conversationScrollStore.scrollUp({ renderableCount: 10, totalHeight: 10 });
      conversationScrollStore.scrollToBottom(10);
      expect(conversationScrollStore.get().scrollOffset).toBe(0);
    });

    it('sets renderableCountAtScroll to provided count', () => {
      conversationScrollStore.scrollToBottom(42);
      expect(conversationScrollStore.get().renderableCountAtScroll).toBe(42);
    });
  });

  describe('toggleDiff', () => {
    it('adds an index when absent', () => {
      conversationScrollStore.toggleDiff(3);
      expect(conversationScrollStore.get().expandedDiffs.has(3)).toBe(true);
    });

    it('removes an index when present', () => {
      conversationScrollStore.toggleDiff(3);
      conversationScrollStore.toggleDiff(3);
      expect(conversationScrollStore.get().expandedDiffs.has(3)).toBe(false);
    });

    it('handles multiple different indices independently', () => {
      conversationScrollStore.toggleDiff(1);
      conversationScrollStore.toggleDiff(5);
      const { expandedDiffs } = conversationScrollStore.get();
      expect(expandedDiffs.has(1)).toBe(true);
      expect(expandedDiffs.has(5)).toBe(true);
    });
  });

  describe('reset', () => {
    it('restores initial state', () => {
      conversationScrollStore.scrollUp({ renderableCount: 5, totalHeight: 10 });
      conversationScrollStore.toggleDiff(2);
      conversationScrollStore.reset();
      const s = conversationScrollStore.get();
      expect(s.scrollOffset).toBe(0);
      expect(s.expandedDiffs.size).toBe(0);
      expect(s.renderableCountAtScroll).toBe(0);
    });
  });
});
