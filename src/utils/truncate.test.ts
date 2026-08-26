import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from './display-text.js';
import {
  truncateByChars,
  truncateByLines,
  truncateByTailLines,
  truncateWithEllipsis,
} from './truncate.js';

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

  it('matches truncateWithEllipsis length contract', () => {
    const input = 'the quick brown fox';
    expect(truncateByChars(input, 8).length).toBe(truncateWithEllipsis(input, 8).length);
  });

  it('returns an empty string when maxChars is zero or negative', () => {
    expect(truncateByChars('abc', 0)).toBe('');
    expect(truncateByChars('abc', -3)).toBe('');
  });
});

describe('truncateByLines', () => {
  it('returns the original when within the limit', () => {
    expect(truncateByLines('a\nb', 2)).toBe('a\nb');
  });

  it('keeps the leading lines when over the limit', () => {
    expect(truncateByLines('a\nb\nc', 2)).toBe('a\nb');
  });
});

describe('truncateByTailLines', () => {
  it('keeps the trailing lines when over the limit', () => {
    expect(truncateByTailLines('a\nb\nc', 2)).toBe('b\nc');
  });
});

describe('truncateWithEllipsis', () => {
  it('returns the original string when it fits the cell budget', () => {
    expect(truncateWithEllipsis('hello', 5)).toBe('hello');
  });

  it('keeps the result within the budget when glyphs are double width', () => {
    const result = truncateWithEllipsis('漢字語', 5);
    expect(getTerminalCellWidth(result)).toBeLessThanOrEqual(5);
    expect(result.startsWith('漢')).toBe(true);
  });

  it('returns an empty string when the budget is zero or negative', () => {
    expect(truncateWithEllipsis('abc', 0)).toBe('');
    expect(truncateWithEllipsis('abc', -2)).toBe('');
  });
});
