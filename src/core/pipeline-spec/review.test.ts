import { describe, expect, it } from 'vitest';
import { REVIEW_CYCLE_CAP, VERDICT_RULES } from './review.js';

describe('review spec', () => {
  it('caps the fix cycles at two', () => {
    expect(REVIEW_CYCLE_CAP).toBe(2);
  });

  it('names the three verdict words and the re-ask sentence', () => {
    expect(VERDICT_RULES.words).toEqual(['pass', 'pass_with_notes', 'fail']);
    expect(VERDICT_RULES.unparseableVerdict).toBe('fail');
    expect(VERDICT_RULES.reaskSentence).toContain('exactly one verdict word');
  });
});
