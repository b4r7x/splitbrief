import { afterEach, describe, expect, it } from 'vitest';
import { reviewStore } from './review.js';

afterEach(() => {
  reviewStore.reset();
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
