import { describe, expect, it } from 'vitest';
import {
  availableRows,
  computeListDisplayWindow,
  isItemIndexVisible,
  windowSlice,
} from './scroll-window.js';

const items = Array.from({ length: 30 }, (_, index) => index);

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

describe('computeListDisplayWindow', () => {
  it('shows every item without indicators when all display rows fit', () => {
    const window = computeListDisplayWindow({
      items: [1, 2, 3, 4, 5, 6],
      selectedIndex: 0,
      rowBudget: 6,
    });

    expect(window.visibleSlots).toHaveLength(6);
    expect(window.visibleSlots.every((slot) => slot.kind === 'item')).toBe(true);
  });

  it('counts indicators inside the row budget', () => {
    const window = computeListDisplayWindow({
      items,
      selectedIndex: 15,
      rowBudget: 5,
    });

    expect(window.visibleSlots).toHaveLength(5);
    expect(window.visibleSlots[0]).toMatchObject({ kind: 'indicator', direction: 'up' });
    expect(window.visibleSlots.at(-1)).toMatchObject({ kind: 'indicator', direction: 'down' });
  });

  it('counts section headers and gaps inside the row budget', () => {
    const window = computeListDisplayWindow({
      items: [
        { id: 'p1', scope: 'project' },
        { id: 'p2', scope: 'project' },
        { id: 'g1', scope: 'global' },
      ],
      selectedIndex: 0,
      rowBudget: 5,
      section: {
        by: (item) => item.scope,
        gapBetweenSections: true,
      },
    });

    expect(window.visibleSlots.map((slot) => slot.kind)).toEqual([
      'header',
      'item',
      'item',
      'gap',
      'indicator',
    ]);
    expect(window.visibleSlots[0]).toEqual({
      kind: 'header',
      itemIndex: 0,
      section: 'project',
    });
    expect(window.visibleSlots[3]).toEqual({ kind: 'gap', itemIndex: 2 });
  });
});

describe('isItemIndexVisible', () => {
  it('returns false when the row budget is zero', () => {
    expect(
      isItemIndexVisible({
        items: ['alpha', 'beta'],
        selectedIndex: 0,
        rowBudget: 0,
      }),
    ).toBe(false);
  });

  it('keeps the selected logical item visible and rejects an empty list', () => {
    const selectedIndex = 20;
    const display = computeListDisplayWindow({
      items,
      selectedIndex,
      rowBudget: 4,
    });

    expect(
      display.visibleSlots.some((slot) => slot.kind === 'item' && slot.itemIndex === selectedIndex),
    ).toBe(true);
    expect(isItemIndexVisible({ items, selectedIndex, rowBudget: 4 })).toBe(true);
    expect(
      isItemIndexVisible({
        items: [],
        selectedIndex: 0,
        rowBudget: 4,
      }),
    ).toBe(false);
  });
});
