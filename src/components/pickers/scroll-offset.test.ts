import { describe, expect, it } from 'vitest';
import { items } from '#testing/helpers/scroll-items.js';
import { availableRows, keepInViewOffset, windowSlice } from './scroll-offset.js';
import { computeListDisplayWindow } from './scroll-window.js';

describe('availableRows', () => {
  it('subtracts chrome rows from terminal rows', () => {
    expect(availableRows({ rows: 40, chromeRows: 2 })).toBe(38);
  });

  it('uses the floor when chrome exceeds rows', () => {
    expect(availableRows({ rows: 6, chromeRows: 12, floor: 2 })).toBe(2);
  });

  it('normalizes negative row inputs and budgets', () => {
    expect(availableRows({ rows: -4, chromeRows: -2, floor: -1 })).toBe(0);
    expect(
      computeListDisplayWindow({
        items: ['alpha'],
        selectedIndex: 0,
        rowBudget: -3,
      }).visibleSlots,
    ).toEqual([]);
  });
});

describe('windowSlice', () => {
  it('returns the visible slice around the selected index', () => {
    const window = windowSlice({
      items,
      selectedIndex: 15,
      windowSize: 5,
    });

    expect(window.visibleSlice).toEqual([13, 14, 15, 16, 17]);
    expect(window.showScrollUp).toBe(true);
    expect(window.showScrollDown).toBe(true);
  });

  it('returns an empty window for a zero or negative row budget', () => {
    for (const windowSize of [0, -2]) {
      expect(windowSlice({ items, selectedIndex: 15, windowSize })).toEqual({
        scrollOffset: 0,
        visibleSlice: [],
        showScrollUp: false,
        showScrollDown: false,
      });
    }
  });
});

describe('keepInViewOffset', () => {
  function offset(previous: number, index: number, totalItems = items.length): number {
    return keepInViewOffset({ previous, index, windowSize: 5, totalItems });
  }

  it('holds the offset while the index stays inside the window', () => {
    expect(offset(0, 4)).toBe(0);
    expect(offset(1, 3)).toBe(1);
  });

  it('moves by the least that brings the index back into view', () => {
    expect(offset(0, 5)).toBe(1);
    expect(offset(10, 9)).toBe(9);
  });

  it('lands on the last window when the selection wraps to the end', () => {
    expect(offset(0, 29)).toBe(25);
  });

  it('pins to the start when every item fits or no row is budgeted', () => {
    expect(offset(3, 3, 4)).toBe(0);
    expect(keepInViewOffset({ previous: 3, index: 20, windowSize: 0, totalItems: 30 })).toBe(0);
  });
});
