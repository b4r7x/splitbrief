import { describe, it, expect } from 'vitest';
import {
  MIN_MAX_DIFF_ROWS,
  MAX_DIFF_ROWS_RATIO,
  getMaxVisibleDiffLines,
} from './diff-height.js';

describe('getMaxVisibleDiffLines', () => {
  it('clamps to MIN_MAX_DIFF_ROWS when ratio result is below floor', () => {
    // 0.5 * 10 = 5, below MIN_MAX_DIFF_ROWS (10)
    expect(getMaxVisibleDiffLines(10)).toBe(MIN_MAX_DIFF_ROWS);
  });

  it('returns MIN_MAX_DIFF_ROWS for zero rows', () => {
    expect(getMaxVisibleDiffLines(0)).toBe(MIN_MAX_DIFF_ROWS);
  });

  it('returns MIN_MAX_DIFF_ROWS for negative rows', () => {
    expect(getMaxVisibleDiffLines(-20)).toBe(MIN_MAX_DIFF_ROWS);
  });

  it('applies ratio math for a mid-size container', () => {
    // 0.5 * 40 = 20, above MIN_MAX_DIFF_ROWS
    expect(getMaxVisibleDiffLines(40)).toBe(Math.floor(40 * MAX_DIFF_ROWS_RATIO));
  });

  it('applies ratio math for a large container', () => {
    // 0.5 * 100 = 50
    expect(getMaxVisibleDiffLines(100)).toBe(Math.floor(100 * MAX_DIFF_ROWS_RATIO));
  });

  it('floor-clamps at exactly the breakeven point', () => {
    // floor(MIN_MAX_DIFF_ROWS / MAX_DIFF_ROWS_RATIO) = floor(10 / 0.5) = 20
    // ratio * 20 = 10, equals MIN_MAX_DIFF_ROWS exactly → max returns floor value
    const breakeven = Math.ceil(MIN_MAX_DIFF_ROWS / MAX_DIFF_ROWS_RATIO);
    expect(getMaxVisibleDiffLines(breakeven)).toBe(MIN_MAX_DIFF_ROWS);
  });

  it('result grows with larger containers', () => {
    expect(getMaxVisibleDiffLines(60)).toBeGreaterThan(getMaxVisibleDiffLines(40));
  });
});
