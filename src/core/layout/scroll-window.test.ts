import { describe, expect, it } from 'vitest';
import {
  computeScrollMaxOffset,
  getScrollWindowState,
} from './scroll-window.js';

describe('computeScrollMaxOffset', () => {
  it('reserves one row for scroll banners when content overflows', () => {
    expect(computeScrollMaxOffset(20, 10, false)).toBe(11);
  });

  it('clamps to zero when content fits in the viewport', () => {
    expect(computeScrollMaxOffset(5, 10, false)).toBe(0);
  });

  it('adds an extra row when the new-events banner is visible', () => {
    expect(computeScrollMaxOffset(20, 10, true)).toBe(12);
  });
});

describe('getScrollWindowState', () => {
  it('derives visible lines from the actual content window', () => {
    expect(getScrollWindowState(20, 10, 0, false)).toMatchObject({
      bannerRows: 1,
      innerHeight: 9,
      linesAbove: 11,
      linesBelow: 0,
    });

    expect(getScrollWindowState(20, 10, 11, false)).toMatchObject({
      bannerRows: 1,
      innerHeight: 9,
      linesAbove: 0,
      linesBelow: 11,
    });
  });

  it('stabilizes when both scroll banners and the new-events banner are visible', () => {
    expect(getScrollWindowState(40, 10, 8, true)).toMatchObject({
      bannerRows: 3,
      innerHeight: 7,
      linesAbove: 25,
      linesBelow: 8,
    });
  });

  it('clamps negative and oversized offsets to valid window geometry', () => {
    expect(getScrollWindowState(20, 10, -5, true)).toMatchObject({
      windowStart: 11,
      windowEnd: 20,
      linesAbove: 11,
      linesBelow: 0,
      newEventRows: 0,
    });

    const oversized = getScrollWindowState(20, 10, 999, false);
    expect(oversized.windowStart).toBe(0);
    expect(oversized.windowEnd).toBeGreaterThanOrEqual(oversized.windowStart);
    expect(oversized.linesAbove).toBeGreaterThanOrEqual(0);
    expect(oversized.linesBelow).toBeGreaterThanOrEqual(0);
  });

  it('keeps an empty viewport window valid', () => {
    const state = getScrollWindowState(0, 0, 4, true);
    expect(state.windowStart).toBe(0);
    expect(state.windowEnd).toBe(0);
    expect(state.innerHeight).toBe(0);
    expect(state.linesAbove).toBe(0);
    expect(state.linesBelow).toBe(0);
  });
});
