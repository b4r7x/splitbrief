import { createStore, storeBase } from './create-store.js';

interface ConversationScrollState {
  scrollOffset: number;
  expandedDiffs: Set<number>;
  eventCountAtScroll: number;
  heightAtScroll: number;
  measuredContentHeight: number;
}

const makeInitial = (): ConversationScrollState => ({
  scrollOffset: 0,
  expandedDiffs: new Set(),
  eventCountAtScroll: 0,
  heightAtScroll: 0,
  measuredContentHeight: 0,
});

const store = createStore<ConversationScrollState>(makeInitial);

export const conversationScrollStore = {
  ...storeBase(store),
  scrollUp: (maxScrollOffset: number, eventCount: number, step = 1, totalHeight = 0) => store.set(s => {
    const next = Math.min(s.scrollOffset + Math.max(1, step), maxScrollOffset);
    const justStarted = s.scrollOffset === 0 && next > 0;
    const countAtScroll = justStarted ? eventCount : s.eventCountAtScroll;
    const heightAtScroll = justStarted ? totalHeight : s.heightAtScroll;
    return { ...s, scrollOffset: next, eventCountAtScroll: countAtScroll, heightAtScroll };
  }),
  scrollDown: (step = 1) => store.set(s => {
    const next = Math.max(0, s.scrollOffset - Math.max(1, step));
    return { ...s, scrollOffset: next, eventCountAtScroll: next === 0 ? 0 : s.eventCountAtScroll, heightAtScroll: next === 0 ? 0 : s.heightAtScroll };
  }),
  scrollToBottom: (eventCount: number) => store.set(s => ({
    ...s,
    scrollOffset: 0,
    eventCountAtScroll: eventCount,
    heightAtScroll: 0,
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
  setMeasuredHeight: (height: number) => store.set(s => {
    if (s.measuredContentHeight === height) return s;
    return { ...s, measuredContentHeight: height };
  }),
};
