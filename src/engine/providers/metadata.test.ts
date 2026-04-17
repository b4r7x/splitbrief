import { describe, it, expect } from 'vitest';
import { formatContextLength } from '../../utils/format-numbers.js';

describe('formatContextLength', () => {
  it('returns empty string for undefined', () => {
    expect(formatContextLength(undefined)).toBe('');
  });

  it('returns empty string for 0', () => {
    expect(formatContextLength(0)).toBe('');
  });

  it('formats small context as K', () => {
    expect(formatContextLength(8000)).toBe('8K');
  });

  it('formats standard context as K', () => {
    expect(formatContextLength(128000)).toBe('128K');
  });

  it('formats million as 1M', () => {
    expect(formatContextLength(1000000)).toBe('1M');
  });

  it('formats non-round millions with decimal', () => {
    expect(formatContextLength(1048576)).toBe('1.0M');
  });

  it('formats 2 million as 2M', () => {
    expect(formatContextLength(2000000)).toBe('2M');
  });

  it('formats 1.5 million with decimal', () => {
    expect(formatContextLength(1500000)).toBe('1.5M');
  });
});
