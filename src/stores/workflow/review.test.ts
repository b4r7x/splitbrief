import { afterEach, describe, expect, it } from 'vitest';
import { reviewStore } from './review.js';
import { focusStore } from '../ui/focus.js';

afterEach(() => {
  reviewStore.reset();
  focusStore.reset();
});

describe('reviewStore brief copy-source model', () => {
  it('clears brief paths when the review file changes', () => {
    reviewStore.setBriefPaths(['src/a.ts']);
    reviewStore.setReviewFile('specs/001/tasks.md');

    expect(reviewStore.get().briefPaths).toEqual([]);
  });

  it('clears brief paths on clearReview', () => {
    reviewStore.setReviewFile('specs/001/tasks.md');
    reviewStore.setBriefPaths(['src/a.ts']);
    reviewStore.clearReview();

    expect(reviewStore.get().briefPaths).toEqual([]);
  });

  it('clears a held brief focus on clearReview so it cannot survive review completion', () => {
    reviewStore.setReviewFile('specs/001/tasks.md');
    reviewStore.setBriefSources(['first brief']);
    focusStore.set('brief', 0);

    reviewStore.clearReview();

    expect(focusStore.get()).toBeNull();
  });
});

describe('reviewStore owner token', () => {
  it('clears the review when the completing owner still owns the session', () => {
    const owner = reviewStore.setReviewFile('specs/001/spec.md');

    reviewStore.clearReviewIfOwner(owner);

    expect(reviewStore.get().filePath).toBeNull();
  });

  it('does not clear a re-claimed review when a superseded owner completes', () => {
    // Mirrors IPC re-delivery: a stale handler resumes after the same prompt was re-claimed.
    const stale = reviewStore.setReviewFile('specs/001/spec.md');
    const live = reviewStore.setReviewFile('specs/001/spec.md');
    expect(stale).not.toBe(live);

    reviewStore.clearReviewIfOwner(stale);
    expect(reviewStore.get().filePath).toBe('specs/001/spec.md');

    reviewStore.clearReviewIfOwner(live);
    expect(reviewStore.get().filePath).toBeNull();
  });
});

describe('reviewStore brief focus reconciliation on scroll', () => {
  it('clears a brief focus that scrolls offscreen', () => {
    reviewStore.setRenderedLineCount(5);
    reviewStore.setVisibleBriefCount(2);
    focusStore.set('brief', 4);

    reviewStore.setScrollOffset(0);

    expect(focusStore.get()).toBeNull();
  });

  it('keeps a brief focus that stays inside the visible window', () => {
    reviewStore.setRenderedLineCount(5);
    reviewStore.setVisibleBriefCount(3);
    focusStore.set('brief', 1);

    reviewStore.setScrollOffset(0);

    expect(focusStore.get()).toEqual({ region: 'brief', index: 1 });
  });

  it('moves focus reconciliation with the scrolled window', () => {
    reviewStore.setRenderedLineCount(10);
    reviewStore.setVisibleBriefCount(3);
    focusStore.set('brief', 0);

    reviewStore.setScrollOffset(5);

    expect(focusStore.get()).toBeNull();
  });

  it('does not touch focus when nothing is focused', () => {
    reviewStore.setRenderedLineCount(5);
    reviewStore.setVisibleBriefCount(2);

    reviewStore.setScrollOffset(3);

    expect(focusStore.get()).toBeNull();
  });

  it('clears brief focus when the visible window is empty', () => {
    focusStore.set('brief', 9);

    reviewStore.setScrollOffset(2);

    expect(focusStore.get()).toBeNull();
  });
});
