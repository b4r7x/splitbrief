import { describe, expect, it } from 'vitest';
import { formatDuration, formatElapsedClock } from './format-time.js';

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

describe('formatElapsedClock', () => {
  it.each([
    [0, '0:00'],
    [3_000, '0:03'],
    [3_599_000, '59:59'],
    [3_600_000, '1:00:00'],
    [10_314_000, '2:51:54'],
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatElapsedClock(ms)).toBe(expected);
  });
});
