import { describe, expect, it } from 'vitest';
import {
  type ScrollWindowState,
  computeScrollMaxOffset,
  getScrollWindowState,
} from './scroll-window.js';

function renderedRows(state: ScrollWindowState): number {
  return state.innerHeight + state.newEventRows + (state.linesBelow > 0 ? 1 : 0);
}

describe('computeScrollMaxOffset', () => {
  it('reserves stable rows for the below scroll banner when content overflows', () => {
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
    expect(
      getScrollWindowState({
        totalHeight: 20,
        viewportHeight: 10,
        scrollOffset: 0,
        hasNewEvents: false,
      }),
    ).toMatchObject({
      bannerRows: 1,
      innerHeight: 9,
      linesAbove: 11,
      linesBelow: 0,
    });

    expect(
      getScrollWindowState({
        totalHeight: 20,
        viewportHeight: 10,
        scrollOffset: 12,
        hasNewEvents: false,
      }),
    ).toMatchObject({
      bannerRows: 1,
      innerHeight: 9,
      linesAbove: 0,
      linesBelow: 11,
    });
  });

  it('stabilizes when the below scroll banner and the new-events banner are visible', () => {
    expect(
      getScrollWindowState({
        totalHeight: 40,
        viewportHeight: 10,
        scrollOffset: 8,
        hasNewEvents: true,
      }),
    ).toMatchObject({
      bannerRows: 2,
      innerHeight: 8,
      linesAbove: 24,
      linesBelow: 8,
    });
  });

  it('moves the content window by one row when the first below banner appears', () => {
    const bottom = getScrollWindowState({
      totalHeight: 20,
      viewportHeight: 10,
      scrollOffset: 0,
      hasNewEvents: false,
    });
    const scrolled = getScrollWindowState({
      totalHeight: 20,
      viewportHeight: 10,
      scrollOffset: 1,
      hasNewEvents: false,
    });

    expect(scrolled.windowStart).toBe(bottom.windowStart - 1);
    expect(scrolled.linesAbove).toBe(bottom.linesAbove - 1);
    expect(scrolled.linesBelow).toBe(1);
  });

  it('reserves the below scroll banner for shallow middle overflow', () => {
    const state = getScrollWindowState({
      totalHeight: 11,
      viewportHeight: 10,
      scrollOffset: 1,
      hasNewEvents: false,
    });

    expect(state).toMatchObject({
      bannerRows: 1,
      innerHeight: 9,
      linesAbove: 1,
      linesBelow: 1,
    });
    expect(renderedRows(state)).toBe(10);
  });

  it('never allocates more rows than the viewport can render', () => {
    const cases = [
      {
        viewportHeight: 10,
        state: getScrollWindowState({
          totalHeight: 11,
          viewportHeight: 10,
          scrollOffset: 1,
          hasNewEvents: false,
        }),
      },
      {
        viewportHeight: 10,
        state: getScrollWindowState({
          totalHeight: 12,
          viewportHeight: 10,
          scrollOffset: 1,
          hasNewEvents: false,
        }),
      },
      {
        viewportHeight: 10,
        state: getScrollWindowState({
          totalHeight: 20,
          viewportHeight: 10,
          scrollOffset: 5,
          hasNewEvents: false,
        }),
      },
      {
        viewportHeight: 10,
        state: getScrollWindowState({
          totalHeight: 40,
          viewportHeight: 10,
          scrollOffset: 8,
          hasNewEvents: true,
        }),
      },
      {
        viewportHeight: 1,
        state: getScrollWindowState({
          totalHeight: 8,
          viewportHeight: 1,
          scrollOffset: 4,
          hasNewEvents: true,
        }),
      },
      {
        viewportHeight: 0,
        state: getScrollWindowState({
          totalHeight: 8,
          viewportHeight: 0,
          scrollOffset: 4,
          hasNewEvents: true,
        }),
      },
    ];

    for (const { viewportHeight, state } of cases) {
      expect(renderedRows(state)).toBeLessThanOrEqual(viewportHeight);
    }
  });

  it('keeps one content row visible before scroll banners in tiny viewports', () => {
    expect(
      getScrollWindowState({
        totalHeight: 8,
        viewportHeight: 1,
        scrollOffset: 4,
        hasNewEvents: true,
      }),
    ).toMatchObject({
      bannerRows: 0,
      innerHeight: 1,
      newEventRows: 0,
    });

    expect(
      getScrollWindowState({
        totalHeight: 8,
        viewportHeight: 2,
        scrollOffset: 4,
        hasNewEvents: true,
      }),
    ).toMatchObject({
      bannerRows: 1,
      innerHeight: 1,
      newEventRows: 1,
    });
  });

  it('clamps negative and oversized offsets to valid window geometry', () => {
    expect(
      getScrollWindowState({
        totalHeight: 20,
        viewportHeight: 10,
        scrollOffset: -5,
        hasNewEvents: true,
      }),
    ).toMatchObject({
      windowStart: 11,
      windowEnd: 20,
      linesAbove: 11,
      linesBelow: 0,
      newEventRows: 0,
    });

    const oversized = getScrollWindowState({
      totalHeight: 20,
      viewportHeight: 10,
      scrollOffset: 999,
      hasNewEvents: false,
    });
    expect(oversized.windowStart).toBe(0);
    expect(oversized.windowEnd).toBeGreaterThanOrEqual(oversized.windowStart);
    expect(oversized.linesAbove).toBeGreaterThanOrEqual(0);
    expect(oversized.linesBelow).toBeGreaterThanOrEqual(0);
  });

  it('keeps an empty viewport window valid', () => {
    const state = getScrollWindowState({
      totalHeight: 0,
      viewportHeight: 0,
      scrollOffset: 4,
      hasNewEvents: true,
    });
    expect(state.windowStart).toBe(0);
    expect(state.windowEnd).toBe(0);
    expect(state.innerHeight).toBe(0);
    expect(state.linesAbove).toBe(0);
    expect(state.linesBelow).toBe(0);
  });
});
