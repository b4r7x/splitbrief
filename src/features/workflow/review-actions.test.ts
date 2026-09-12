import { describe, it, expect } from 'vitest';
import { DEFAULT_REVIEW_ACTION_ID, nextReviewActionId } from './review-actions.js';

describe('nextReviewActionId', () => {
  it('starts on approve and steps forward through the selectable actions', () => {
    expect(DEFAULT_REVIEW_ACTION_ID).toBe('approve');
    expect(nextReviewActionId('approve', 'next')).toBe('edit-file');
    expect(nextReviewActionId('edit-file', 'next')).toBe('reject');
  });

  it('steps back to approve', () => {
    expect(nextReviewActionId('reject', 'previous')).toBe('edit-file');
    expect(nextReviewActionId('edit-file', 'previous')).toBe('approve');
  });

  it('clamps at both ends rather than wrapping', () => {
    expect(nextReviewActionId('approve', 'previous')).toBe('approve');
    expect(nextReviewActionId('reject', 'next')).toBe('reject');
  });
});
