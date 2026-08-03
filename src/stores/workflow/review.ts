import { clamp } from '../../utils/math.js';
import { createStore, storeBase } from '../create-store.js';
import { focusStore } from '../ui/focus.js';

export type ReviewSource =
  | Readonly<{ kind: 'file'; filePath: string }>
  | Readonly<{ kind: 'artifact'; text: string }>;

export interface ReviewState {
  source: ReviewSource | null;
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
  source: null,
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
  return setReviewSource(
    path === null ? null : { kind: 'file', filePath: path },
    renderedLineCount,
  );
}

function setReviewArtifact(text: string): number {
  return setReviewSource({ kind: 'artifact', text });
}

function setReviewSource(source: ReviewSource | null, renderedLineCount?: number): number {
  const ownerToken = nextOwnerToken++;
  store.set((s) =>
    sameReviewSource(s.source, source)
      ? { ...s, ownerToken }
      : {
          ...s,
          source: copyReviewSource(source),
          filePath: reviewSourceFilePath(source),
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

function sameReviewSource(left: ReviewSource | null, right: ReviewSource | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === 'file') {
    return right.kind === 'file' && left.filePath === right.filePath;
  }
  return right.kind === 'artifact' && left.text === right.text;
}

function copyReviewSource(source: ReviewSource | null): ReviewSource | null {
  if (source === null) return null;
  return source.kind === 'file'
    ? { kind: 'file', filePath: source.filePath }
    : { kind: 'artifact', text: source.text };
}

function reviewSourceFilePath(source: ReviewSource | null): string | null {
  return source?.kind === 'file' ? source.filePath : null;
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
    s.source?.kind !== 'file'
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
  store.set((s) => (s.source === null ? s : initial));
}

function clearReviewIfOwner(ownerToken: number) {
  if (store.get().ownerToken !== ownerToken) return;
  clearReview();
}

export const reviewStore = {
  ...storeBase(store),
  setReviewFile,
  setReviewArtifact,
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
