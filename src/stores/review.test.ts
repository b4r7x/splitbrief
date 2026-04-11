import { describe, it, expect, beforeEach } from 'vitest';
import { reviewStore } from './review.js';

describe('reviewStore', () => {
  beforeEach(() => reviewStore.reset());

  describe('initial state', () => {
    it('starts with null filePath', () => {
      expect(reviewStore.get().filePath).toBeNull();
    });

    it('starts with scrollOffset 0', () => {
      expect(reviewStore.get().scrollOffset).toBe(0);
    });

    it('starts with lineCount 0', () => {
      expect(reviewStore.get().lineCount).toBe(0);
    });
  });

  describe('setReviewFile', () => {
    it('sets filePath', () => {
      reviewStore.setReviewFile('/path/to/spec.md');
      expect(reviewStore.get().filePath).toBe('/path/to/spec.md');
    });

    it('sets lineCount when provided', () => {
      reviewStore.setReviewFile('/path/to/spec.md', 100);
      expect(reviewStore.get().lineCount).toBe(100);
    });

    it('resets scrollOffset when file changes', () => {
      reviewStore.setScrollOffset(50);
      reviewStore.setReviewFile('/new/file.md');
      expect(reviewStore.get().scrollOffset).toBe(0);
    });

    it('short-circuits when filePath is unchanged', () => {
      reviewStore.setReviewFile('/path/to/spec.md');
      const before = reviewStore.get();
      reviewStore.setReviewFile('/path/to/spec.md');
      expect(reviewStore.get()).toBe(before);
    });

    it('clears filePath when null', () => {
      reviewStore.setReviewFile('/path/to/spec.md');
      reviewStore.setReviewFile(null);
      expect(reviewStore.get().filePath).toBeNull();
    });
  });

  describe('setScrollOffset', () => {
    it('sets scrollOffset', () => {
      reviewStore.setScrollOffset(42);
      expect(reviewStore.get().scrollOffset).toBe(42);
    });

    it('short-circuits when value is unchanged', () => {
      reviewStore.setScrollOffset(10);
      const before = reviewStore.get();
      reviewStore.setScrollOffset(10);
      expect(reviewStore.get()).toBe(before);
    });
  });

  describe('setLineCount', () => {
    it('sets lineCount', () => {
      reviewStore.setLineCount(100);
      expect(reviewStore.get().lineCount).toBe(100);
    });

    it('short-circuits when value is unchanged', () => {
      reviewStore.setLineCount(50);
      const before = reviewStore.get();
      reviewStore.setLineCount(50);
      expect(reviewStore.get()).toBe(before);
    });
  });

  describe('clearReview', () => {
    it('resets to initial state', () => {
      reviewStore.setReviewFile('/path/to/spec.md', 100);
      reviewStore.setScrollOffset(50);
      reviewStore.clearReview();
      expect(reviewStore.get()).toEqual({
        filePath: null,
        scrollOffset: 0,
        lineCount: 0,
      });
    });

    it('short-circuits when already cleared', () => {
      const before = reviewStore.get();
      reviewStore.clearReview();
      expect(reviewStore.get()).toBe(before);
    });
  });

  describe('store interface', () => {
    it('exposes use, get, reset methods', () => {
      expect(typeof reviewStore.use).toBe('function');
      expect(typeof reviewStore.get).toBe('function');
      expect(typeof reviewStore.reset).toBe('function');
    });
  });
});
