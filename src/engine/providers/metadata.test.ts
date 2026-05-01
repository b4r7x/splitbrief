import { describe, it, expect } from 'vitest';
import { formatContextLength } from '../../core/formatting.js';

describe('formatContextLength', () => {
  it.each([
    [undefined, ''],
    [0, ''],
    [8000, '8K'],
    [128000, '128K'],
    [1000000, '1M'],
    [1048576, '1.0M'],
    [2000000, '2M'],
    [1500000, '1.5M'],
  ] as const)('formats %s as %s', (input, expected) => {
    expect(formatContextLength(input)).toBe(expected);
  });
});
