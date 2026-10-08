import { describe, expect, it } from 'vitest';
import { formatDuration } from './format-time.js';

describe('formatDuration', () => {
  it.each([
    [0, '0.0s'],
    [3000, '3.0s'],
    [59_940, '59.9s'],
    [59_960, '1m 0s'],
    [60_000, '1m 0s'],
    [2_814_200, '46m 54s'],
    [4_141_000, '1h 9m 1s'],
    [-5, '0.0s'],
    [Number.NaN, '0.0s'],
    [Number.POSITIVE_INFINITY, '0.0s'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});
