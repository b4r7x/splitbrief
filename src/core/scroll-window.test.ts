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
});
