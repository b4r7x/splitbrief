import { describe, it, expect } from 'vitest';
import { computeEta } from './compute-eta.js';

describe('computeEta', () => {
  it('returns empty when no tasks completed yet', () => {
    expect(computeEta([], 0, 5)).toBe('');
  });

  it('returns empty when all tasks done', () => {
    expect(computeEta([3000, 4000], 5, 5)).toBe('');
  });

  it('calculates ETA from average task time', () => {
    // avg = 5000ms, remaining = 2 tasks → ~10s remaining
    const result = computeEta([4000, 6000], 3, 5);
    expect(result).toBe('~10s remaining');
  });

  it('formats minutes for longer ETAs', () => {
    // avg = 120_000ms (2m), remaining = 3 → ~6m remaining
    const result = computeEta([120_000, 120_000], 2, 5);
    expect(result).toBe('~6m 0s remaining');
  });

  it('returns empty when currentTask exceeds totalTasks', () => {
    expect(computeEta([5000], 6, 5)).toBe('');
  });

  it('handles zero completion times', () => {
    const result = computeEta([0, 0], 1, 3);
    expect(result).toBe('');
  });

  it('uses the most recent completion time when an earlier entry is negative', () => {
    const result = computeEta([-1000, 2000], 1, 3);
    expect(result).toBe('~1s remaining');
  });
});
