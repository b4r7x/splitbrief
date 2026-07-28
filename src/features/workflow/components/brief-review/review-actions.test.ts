import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_ACTION_ID,
  getReviewActionCommand,
  nextReviewActionId,
  REVIEW_ACTIONS,
  REVIEW_ACTION_IDS,
} from './review-actions.js';

describe('review action contract', () => {
  it('keeps four stable action ids with one default and command mapping', () => {
    expect(REVIEW_ACTION_IDS).toEqual(['approve', 'edit-file', 'comment', 'reject']);
    expect(DEFAULT_REVIEW_ACTION_ID).toBe('approve');
    expect(REVIEW_ACTIONS.map((action) => action.command)).toEqual([
      'approve',
      'edit-file',
      null,
      'reject',
    ]);
    expect(getReviewActionCommand('approve')).toBe('approve');
  });

  it('moves by logical id and clamps at both ends', () => {
    expect(nextReviewActionId('approve', 'previous')).toBe('approve');
    expect(nextReviewActionId('approve', 'next')).toBe('edit-file');
    expect(nextReviewActionId('edit-file', 'next')).toBe('reject');
    expect(nextReviewActionId('reject', 'next')).toBe('reject');
    expect(nextReviewActionId('reject', 'previous')).toBe('edit-file');
  });
});
