import { describe, it, expect } from 'vitest';
import { truncateWithEllipsis, truncateByChars, truncateByLines } from './truncate.js';

describe('truncateWithEllipsis', () => {
  it('returns original string when shorter than max', () => {
    expect(truncateWithEllipsis('hello', 10)).toBe('hello');
  });

  it('truncates and adds ellipsis when longer than max', () => {
    expect(truncateWithEllipsis('hello world', 5)).toBe('hell\u2026');
  });

  it('returns empty string for max=0', () => {
    expect(truncateWithEllipsis('hello', 0)).toBe('');
  });
});

describe('truncateByChars', () => {
  it('truncates strings exceeding maxChars and appends marker', () => {
    expect(truncateByChars('hello world', 5)).toBe('hello...[truncated]');
    expect(truncateByChars('short', 10)).toBe('short');
  });
});

describe('truncateByLines', () => {
  it('keeps only the first maxLines lines', () => {
    expect(truncateByLines('a\nb\nc\nd', 2)).toBe('a\nb');
    expect(truncateByLines('a\nb', 5)).toBe('a\nb');
  });
});
