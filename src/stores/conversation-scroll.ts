import { createStore, storeBase } from './create-store.js';

interface ConversationScrollState {
  scrollOffset: number;
  expandedDiffs: Set<number>;
  eventCountAtScroll: number;
}

const INITIAL: ConversationScrollState = {
  scrollOffset: 0,
  expandedDiffs: new Set(),
  eventCountAtScroll: 0,
};

const store = createStore<ConversationScrollState>(INITIAL);

export const conversationScrollStore = {
  ...storeBase(store),
  scrollUp: (maxScrollOffset: number, eventCount: number) => store.set(s => {
    const next = Math.min(s.scrollOffset + 1, maxScrollOffset);
    const countAtScroll = s.scrollOffset === 0 && next > 0 ? eventCount : s.eventCountAtScroll;
    return { ...s, scrollOffset: next, eventCountAtScroll: countAtScroll };
  }),
  scrollDown: () => store.set(s => {
    const next = Math.max(0, s.scrollOffset - 1);
    return { ...s, scrollOffset: next, eventCountAtScroll: next === 0 ? 0 : s.eventCountAtScroll };
  }),
  scrollToBottom: (eventCount: number) => store.set(s => ({
    ...s,
    scrollOffset: 0,
    eventCountAtScroll: eventCount,
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
  reset: () => store.set({ ...INITIAL, expandedDiffs: new Set() }),
};
