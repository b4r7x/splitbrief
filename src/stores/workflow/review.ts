import { createStore, storeBase } from '../create-store.js';

export interface ReviewState {
  filePath: string | null;
  scrollOffset: number;
  renderedLineCount: number;
  revision: number;
}

const initial: ReviewState = {
  filePath: null,
  scrollOffset: 0,
  renderedLineCount: 0,
  revision: 0,
};

const store = createStore<ReviewState>(initial);

function setReviewFile(path: string | null, renderedLineCount?: number) {
  store.set((s) =>
    s.filePath === path
      ? s
      : {
          ...s,
          filePath: path,
          scrollOffset: 0,
          renderedLineCount: renderedLineCount ?? 0,
          revision: 0,
        },
  );
}

function setScrollOffset(offset: number) {
  store.set((s) => (s.scrollOffset === offset ? s : { ...s, scrollOffset: offset }));
}

function setRenderedLineCount(count: number) {
  store.set((s) => (s.renderedLineCount === count ? s : { ...s, renderedLineCount: count }));
}

function reloadReviewFile() {
  store.set((s) =>
    s.filePath === null
      ? s
      : { ...s, revision: s.revision + 1, scrollOffset: 0, renderedLineCount: 0 },
  );
}

function clearReview() {
  store.set((s) => (s.filePath === null ? s : initial));
}

export const reviewStore = {
  ...storeBase(store),
  setReviewFile,
  setScrollOffset,
  setRenderedLineCount,
  reloadReviewFile,
  clearReview,
};
