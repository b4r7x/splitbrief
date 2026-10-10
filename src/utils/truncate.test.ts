import { describe, expect, it } from 'vitest';
import { truncateByChars, truncateByTailLines } from './truncate.js';

describe('truncateByChars', () => {
  it('returns the original string when within the limit', () => {
    expect(truncateByChars('hello', 5)).toBe('hello');
    expect(truncateByChars('hi', 10)).toBe('hi');
  });

  it('fits the result within maxChars when truncating', () => {
    const result = truncateByChars('abcdefghij', 5);
    expect(result.length).toBe(5);
    expect(result).toBe('abcd…');
  });

  it('spends one of the maxChars on the ellipsis', () => {
    expect(truncateByChars('the quick brown fox', 8)).toBe('the qui…');
  });

  it('returns an empty string when maxChars is zero or negative', () => {
    expect(truncateByChars('abc', 0)).toBe('');
    expect(truncateByChars('abc', -3)).toBe('');
  });
});

describe('truncateByTailLines', () => {
  it('keeps the trailing lines when over the limit', () => {
    expect(truncateByTailLines('a\nb\nc', 2)).toBe('b\nc');
  });
});
