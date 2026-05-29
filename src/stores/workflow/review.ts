import { createStore, storeBase } from '../create-store.js';

export interface ReviewState {
  filePath: string | null;
  scrollOffset: number;
  lineCount: number;
}

const initial: ReviewState = {
  filePath: null,
  scrollOffset: 0,
  lineCount: 0,
};

const store = createStore<ReviewState>(initial);

function setReviewFile(path: string | null, lineCount?: number) {
  store.set((s) =>
    s.filePath === path ? s : { ...s, filePath: path, scrollOffset: 0, lineCount: lineCount ?? 0 },
  );
}

function setScrollOffset(offset: number) {
  store.set((s) => (s.scrollOffset === offset ? s : { ...s, scrollOffset: offset }));
}

function setLineCount(count: number) {
  store.set((s) => (s.lineCount === count ? s : { ...s, lineCount: count }));
}

function clearReview() {
  store.set((s) => (s.filePath === null ? s : initial));
}

export const reviewStore = {
  ...storeBase(store),
  setReviewFile,
  setScrollOffset,
  setLineCount,
  clearReview,
};
