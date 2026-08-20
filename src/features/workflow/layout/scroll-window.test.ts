import { describe, expect, it } from 'vitest';
import {
  computeScrollMaxOffset,
  getScrollWindowState,
  normalizeScrollRows,
} from './scroll-window.js';
import { getWorkflowContentRect, getWorkflowSidebarWidth } from './rect.js';

describe('computeScrollMaxOffset', () => {
  it('is the overflow beyond the viewport', () => {
    expect(computeScrollMaxOffset({ totalHeight: 20, viewportHeight: 10 })).toBe(10);
  });

  it('clamps to zero when content fits in the viewport', () => {
    expect(computeScrollMaxOffset({ totalHeight: 5, viewportHeight: 10 })).toBe(0);
  });
});

describe('getScrollWindowState', () => {
  it('gives the window the full viewport — banners ride the chrome dividers', () => {
    expect(
      getScrollWindowState({ totalHeight: 20, viewportHeight: 10, scrollOffset: 0 }),
    ).toMatchObject({
      innerHeight: 10,
      windowStart: 10,
      windowEnd: 20,
      linesAbove: 10,
      linesBelow: 0,
    });
  });

  it('reports lines below when scrolled up', () => {
    expect(
      getScrollWindowState({ totalHeight: 20, viewportHeight: 10, scrollOffset: 10 }),
    ).toMatchObject({
      innerHeight: 10,
      windowStart: 0,
      windowEnd: 10,
      linesAbove: 0,
      linesBelow: 10,
    });
  });

  it('moves the window one row per scroll step', () => {
    const bottom = getScrollWindowState({ totalHeight: 20, viewportHeight: 10, scrollOffset: 0 });
    const scrolled = getScrollWindowState({ totalHeight: 20, viewportHeight: 10, scrollOffset: 1 });

    expect(scrolled.windowStart).toBe(bottom.windowStart - 1);
    expect(scrolled.linesAbove).toBe(bottom.linesAbove - 1);
    expect(scrolled.linesBelow).toBe(1);
  });

  it('clamps negative and oversized offsets to valid window geometry', () => {
    expect(
      getScrollWindowState({ totalHeight: 20, viewportHeight: 10, scrollOffset: -5 }),
    ).toMatchObject({
      windowStart: 10,
      windowEnd: 20,
      linesAbove: 10,
      linesBelow: 0,
    });

    const oversized = getScrollWindowState({
      totalHeight: 20,
      viewportHeight: 10,
      scrollOffset: 999,
    });
    expect(oversized.windowStart).toBe(0);
    expect(oversized.windowEnd).toBe(10);
    expect(oversized.linesBelow).toBe(10);
  });

  it('keeps an empty viewport window valid', () => {
    const state = getScrollWindowState({ totalHeight: 0, viewportHeight: 0, scrollOffset: 4 });
    expect(state.windowStart).toBe(0);
    expect(state.windowEnd).toBe(0);
    expect(state.innerHeight).toBe(0);
    expect(state.linesAbove).toBe(0);
    expect(state.linesBelow).toBe(0);
  });

  it('clips to the whole caller-owned body height at every sidebar width', () => {
    const rows = 24;
    const inputRows = 3;
    const noSidebar = getWorkflowContentRect({ cols: 80, rows, inputRows, sidebarVisible: false });

    for (const cols of [121, 120, 119, 80, 50, 40]) {
      const rect = getWorkflowContentRect({ cols, rows, inputRows, sidebarVisible: true });
      const sidebarWidth = getWorkflowSidebarWidth({ cols, sidebarVisible: true });
      const state = getScrollWindowState({
        totalHeight: rect.height,
        viewportHeight: rect.height,
        scrollOffset: 0,
      });

      expect(rect.height, `body height beside a ${sidebarWidth}-wide sidebar`).toBe(
        noSidebar.height,
      );
      expect(state.innerHeight).toBe(rect.height);
      expect(state.windowEnd).toBe(rect.height);
      expect(rect.top + state.windowEnd - 1).toBe(rect.bottom);
      expect(rect.bottom).toBe(noSidebar.bottom);
    }
  });

  it('uses only whole, non-negative rows while a resize is incomplete', () => {
    expect(normalizeScrollRows(8.9)).toBe(8);
    expect(normalizeScrollRows(-2)).toBe(0);
    expect(normalizeScrollRows(Number.NaN)).toBe(0);
    expect(normalizeScrollRows(Number.POSITIVE_INFINITY)).toBe(0);

    expect(
      getScrollWindowState({
        totalHeight: 8.9,
        viewportHeight: 3.9,
        scrollOffset: Number.NaN,
      }),
    ).toEqual({
      innerHeight: 3,
      windowStart: 5,
      windowEnd: 8,
      linesAbove: 5,
      linesBelow: 0,
    });
  });
});
