import { describe, it, expect } from 'vitest';
import { computeEta } from './compute-eta.js';

describe('computeEta', () => {
  it.each([
    ['returns empty when no tasks completed yet', [], 0, 5, ''],
    [
      'counts the in-progress task while the final task is running',
      [3000, 4000],
      5,
      5,
      '~3s remaining',
    ],
    ['calculates ETA from average task time', [4000, 6000], 3, 5, '~15s remaining'],
    ['formats minutes for longer ETAs', [120_000, 120_000], 2, 5, '~8m 0s remaining'],
    ['returns empty when currentTask exceeds totalTasks', [5000], 6, 5, ''],
    ['handles zero completion times', [0, 0], 1, 3, ''],
    [
      'averages all supplied completion times when one sample is negative',
      [-1000, 2000],
      1,
      3,
      '~1s remaining',
    ],
  ] as const)('%s', (_label, times, current, total, expected) => {
    expect(computeEta([...times], current, total)).toBe(expected);
  });
});
