import { clamp } from '../../utils/math.js';
import { createStore, storeBase } from '../create-store.js';
import { focusStore } from '../ui/focus.js';

export interface ReviewState {
  filePath: string | null;
  scrollOffset: number;
  renderedLineCount: number;
  briefSources: readonly string[];
  briefPaths: readonly string[];
  visibleBriefCount: number;
  loadError: string | null;
  revision: number;
  ownerToken: number;
}

const initial: ReviewState = {
  filePath: null,
  scrollOffset: 0,
  renderedLineCount: 0,
  briefSources: [],
  briefPaths: [],
  visibleBriefCount: 0,
  loadError: null,
  revision: 0,
  ownerToken: 0,
};

const store = createStore<ReviewState>(initial);

let nextOwnerToken = 1;

function setReviewFile(path: string | null, renderedLineCount?: number): number {
  const ownerToken = nextOwnerToken++;
  store.set((s) =>
    s.filePath === path
      ? { ...s, ownerToken }
      : {
          ...s,
          filePath: path,
          scrollOffset: 0,
          renderedLineCount: renderedLineCount ?? 0,
          briefSources: [],
          briefPaths: [],
          visibleBriefCount: 0,
          loadError: null,
          revision: 0,
          ownerToken,
        },
  );
  return ownerToken;
}

export interface VisibleBriefWindow {
  start: number;
  count: number;
}

// The first brief index painted at the current scroll offset. The visible window is
// [start, start + count); rows outside it are not rendered and are not copy-actionable.
export function getVisibleBriefWindow(s: ReviewState = store.get()): VisibleBriefWindow {
  if (s.visibleBriefCount <= 0) return { start: 0, count: 0 };
  const maxStart = Math.max(0, s.renderedLineCount - s.visibleBriefCount);
  return {
    start: clamp(Math.floor(s.scrollOffset), 0, maxStart),
    count: s.visibleBriefCount,
  };
}

export function isBriefIndexVisible(index: number, s: ReviewState = store.get()): boolean {
  const { start, count } = getVisibleBriefWindow(s);
  return count > 0 && index >= start && index < start + count;
}

function reconcileBriefFocus() {
  const focus = focusStore.get();
  if (focus === null || focus.region !== 'brief') return;
  if (!isBriefIndexVisible(focus.index)) focusStore.clear();
}

function setScrollOffset(offset: number) {
  store.set((s) => (s.scrollOffset === offset ? s : { ...s, scrollOffset: offset }));
  reconcileBriefFocus();
}

function setRenderedLineCount(count: number) {
  store.set((s) => (s.renderedLineCount === count ? s : { ...s, renderedLineCount: count }));
}

function setBriefSources(sources: readonly string[]) {
  store.set((s) => (s.briefSources === sources ? s : { ...s, briefSources: sources }));
}

function setBriefPaths(paths: readonly string[]) {
  store.set((s) => (s.briefPaths === paths ? s : { ...s, briefPaths: paths }));
}

function setVisibleBriefCount(count: number) {
  store.set((s) => (s.visibleBriefCount === count ? s : { ...s, visibleBriefCount: count }));
}

function setLoadError(loadError: string | null) {
  store.set((s) => (s.loadError === loadError ? s : { ...s, loadError }));
}

function reloadReviewFile() {
  store.set((s) =>
    s.filePath === null
      ? s
      : {
          ...s,
          revision: s.revision + 1,
          scrollOffset: 0,
          renderedLineCount: 0,
          briefSources: [],
          briefPaths: [],
          visibleBriefCount: 0,
          loadError: null,
        },
  );
}

function clearReview() {
  focusStore.clear();
  store.set((s) => (s.filePath === null ? s : initial));
}

function clearReviewIfOwner(ownerToken: number) {
  if (store.get().ownerToken !== ownerToken) return;
  clearReview();
}

export const reviewStore = {
  ...storeBase(store),
  setReviewFile,
  setScrollOffset,
  setRenderedLineCount,
  setBriefSources,
  setBriefPaths,
  setVisibleBriefCount,
  setLoadError,
  reloadReviewFile,
  clearReview,
  clearReviewIfOwner,
};
