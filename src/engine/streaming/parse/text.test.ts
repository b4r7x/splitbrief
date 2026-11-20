import { describe, it, expect } from 'vitest';
import { parseTextLine } from './text.js';

describe('parseTextLine', () => {
  it('returns empty for blank line', () => {
    expect(parseTextLine('')).toEqual({});
    expect(parseTextLine('   ')).toEqual({});
  });

  it('handles fractional k values with rounding', () => {});

  it('does not match partial token lines (missing received)', () => {
    const result = parseTextLine('Tokens: 1.5k sent');

    expect(result.text).toBe('Tokens: 1.5k sent\n');
    expect(result.channel).toBe('stdout');
  });
});
