import { describe, expect, it } from 'vitest';
import { VERDICT_RULES } from './review.js';

describe('review spec', () => {
  it('names the three verdict words and the re-ask sentence', () => {
    expect(VERDICT_RULES.words).toEqual(['pass', 'pass_with_notes', 'fail']);
    expect(VERDICT_RULES.unparseableVerdict).toBe('fail');
    expect(VERDICT_RULES.reaskSentence).toContain('exactly one verdict word');
  });

  it('keeps no automatic finding owner for the typed review to replace', () => {
    expect(VERDICT_RULES).not.toHaveProperty('findingOwner');
    expect(VERDICT_RULES).not.toHaveProperty('unmatchedFindingOwner');
  });
});
