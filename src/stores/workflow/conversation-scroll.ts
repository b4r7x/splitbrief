import { createStore, storeBase } from '../create-store.js';

interface ConversationScrollState {
  scrollOffset: number;
  expandedDiffs: Set<number>;
  renderableCountAtScroll: number;
  heightAtScroll: number;
}

const initial = (): ConversationScrollState => ({
  scrollOffset: 0,
  expandedDiffs: new Set(),
  renderableCountAtScroll: 0,
  heightAtScroll: 0,
});

function clearAnchor<T extends { renderableCountAtScroll: number; heightAtScroll: number }>(s: T): T {
  return { ...s, renderableCountAtScroll: 0, heightAtScroll: 0 };
}

const store = createStore<ConversationScrollState>(initial);

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<ConversationScrollState>): void {
  store.set(next ? { ...initial(), ...next } : initial());
}

export const conversationScrollStore = {
  ...storeBase(store),
  __testReset,
  scrollUp: ({ renderableCount, totalHeight, step = 1 }: { renderableCount: number; totalHeight: number; step?: number }) => store.set(s => {
    const next = Math.min(s.scrollOffset + Math.max(1, step), totalHeight);
    const justStarted = s.scrollOffset === 0 && next > 0;
    const countAtScroll = justStarted ? renderableCount : s.renderableCountAtScroll;
    const heightAtScroll = justStarted ? totalHeight : s.heightAtScroll;
    return { ...s, scrollOffset: next, renderableCountAtScroll: countAtScroll, heightAtScroll };
  }),
  scrollDown: (step = 1) => store.set(s => {
    const next = Math.max(0, s.scrollOffset - Math.max(1, step));
    return next === 0 ? clearAnchor({ ...s, scrollOffset: 0 }) : { ...s, scrollOffset: next };
  }),
  scrollToBottom: (renderableCount: number) => store.set(s => ({
    ...clearAnchor({ ...s, scrollOffset: 0 }),
    renderableCountAtScroll: renderableCount,
  })),
  toggleDiff: (idx: number) => store.set(s => {
    const next = new Set(s.expandedDiffs);
    if (next.has(idx)) {
      next.delete(idx);
    } else {
      next.add(idx);
    }
    return { ...s, expandedDiffs: next };
  }),
};
