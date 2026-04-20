import { describe, expect, it } from 'vitest';
import { estimateTokens } from './estimate.js';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('returns 1 for exactly 4 chars', () => {
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('rounds up for 5 chars', () => {
    expect(estimateTokens('abcde')).toBe(2);
  });
});
