import { describe, expect, it } from 'vitest';
import {
  availableRows,
  computeListDisplayWindow,
  isItemIndexVisible,
  keepInViewOffset,
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

  it('counts section headers inside the row budget and drops a gap with no row under it', () => {
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
      'indicator',
    ]);
    expect(window.visibleSlots[0]).toEqual({
      kind: 'header',
      itemIndex: 0,
      section: 'project',
    });
  });

  it('never ends the window on a section header whose rows are below the fold', () => {
    const window = computeListDisplayWindow({
      items: [
        { id: 'p1', scope: 'project' },
        { id: 'p2', scope: 'project' },
        { id: 'p3', scope: 'project' },
        { id: 'g1', scope: 'global' },
        { id: 'g2', scope: 'global' },
      ],
      selectedIndex: 0,
      rowBudget: 7,
      section: {
        by: (item) => item.scope,
        gapBetweenSections: true,
      },
    });

    expect(window.visibleSlots.map((slot) => slot.kind)).toEqual([
      'header',
      'item',
      'item',
      'item',
      'indicator',
    ]);
  });
});

describe('totalSlots', () => {
  it('counts only items for a plain list', () => {
    const window = computeListDisplayWindow({
      items: ['a', 'b', 'c'],
      selectedIndex: 0,
      rowBudget: 10,
    });

    expect(window.totalSlots).toBe(3);
  });

  it('counts items plus section headers', () => {
    const list = Array.from({ length: 9 }, (_, index) => ({
      id: `i${index}`,
      scope: `s${Math.floor(index / 3)}`,
    }));
    const window = computeListDisplayWindow({
      items: list,
      selectedIndex: 0,
      rowBudget: 20,
      section: { by: (item) => item.scope },
    });

    expect(window.totalSlots).toBe(12);
  });

  it('counts items plus section headers plus inter-section gaps', () => {
    const list = Array.from({ length: 9 }, (_, index) => ({
      id: `i${index}`,
      scope: `s${Math.floor(index / 3)}`,
    }));
    const window = computeListDisplayWindow({
      items: list,
      selectedIndex: 0,
      rowBudget: 20,
      section: { by: (item) => item.scope, gapBetweenSections: true },
    });

    expect(window.totalSlots).toBe(14);
  });

  it('counts items plus decoration rows', () => {
    const window = computeListDisplayWindow({
      items: ['a', 'b', 'c', 'd'],
      selectedIndex: 0,
      rowBudget: 10,
      decorations: { after: (_item, index) => index === 1 },
    });

    expect(window.totalSlots).toBe(5);
  });

  it('is 0 for an empty list', () => {
    const window = computeListDisplayWindow({
      items: [],
      selectedIndex: 0,
      rowBudget: 10,
    });

    expect(window.totalSlots).toBe(0);
    expect(window.visibleSlots).toEqual([]);
  });

  it('is 0 when the row budget is zero', () => {
    const window = computeListDisplayWindow({
      items: ['a', 'b'],
      selectedIndex: 0,
      rowBudget: 0,
    });

    expect(window.totalSlots).toBe(0);
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

describe('decoration slots', () => {
  it('renders before and after slots around their item and counts them in the budget', () => {
    const window = computeListDisplayWindow({
      items: ['alpha', 'beta', 'gamma'],
      selectedIndex: 0,
      rowBudget: 4,
      decorations: {
        before: (item) => item === 'alpha',
        after: (item) => item === 'beta',
      },
    });

    expect(window.visibleSlots.map((slot) => slot.kind)).toEqual([
      'before',
      'item',
      'item',
      'indicator',
    ]);
    expect(window.visibleSlots[0]).toEqual({ kind: 'before', itemIndex: 0 });
  });

  it('keeps the selected item visible when decorations crowd the window', () => {
    expect(
      isItemIndexVisible({
        items,
        selectedIndex: 20,
        rowBudget: 6,
        decorations: { before: () => true, after: () => true },
      }),
    ).toBe(true);
  });
});

describe('section headers', () => {
  it('renders a section boundary as a gap only when headerFor is false', () => {
    const window = computeListDisplayWindow({
      items: [
        { id: 'p1', scope: 'project' },
        { id: 'g1', scope: 'global' },
      ],
      selectedIndex: 0,
      rowBudget: 6,
      section: {
        by: (item) => item.scope,
        gapBetweenSections: true,
        headerFor: (scope) => scope === 'project',
      },
    });

    expect(window.visibleSlots.map((slot) => slot.kind)).toEqual(['header', 'item', 'gap', 'item']);
  });
});

describe('pinnedHead', () => {
  it('keeps the head of the list on screen where an unpinned list would already have scrolled', () => {
    const unpinned = computeListDisplayWindow({ items, selectedIndex: 5, rowBudget: 8 });
    expect(unpinned.scrollOffset).toBeGreaterThan(0);

    const window = computeListDisplayWindow({
      items,
      selectedIndex: 5,
      rowBudget: 8,
      pinnedHead: 8,
    });

    expect(window.scrollOffset).toBe(0);
    expect(window.showScrollUp).toBe(false);
    expect(
      window.visibleSlots.filter((slot) => slot.kind === 'item').map((slot) => slot.itemIndex),
    ).toEqual(expect.arrayContaining([0, 1, 2, 3, 4, 5]));
  });

  it('keeps the selection on screen when the pinned head is taller than the window', () => {
    const window = computeListDisplayWindow({
      items,
      selectedIndex: 7,
      rowBudget: 5,
      pinnedHead: 8,
    });

    expect(
      window.visibleSlots.filter((slot) => slot.kind === 'item').map((slot) => slot.itemIndex),
    ).toContain(7);
  });

  it('scrolls normally once the selection leaves the pinned head', () => {
    const window = computeListDisplayWindow({
      items,
      selectedIndex: 20,
      rowBudget: 10,
      pinnedHead: 3,
    });

    expect(window.scrollOffset).toBeGreaterThan(0);
  });
});

describe('decorations', () => {
  it('never renders a decoration for an item that scrolled out of the window', () => {
    for (const selectedIndex of [8, 9]) {
      const window = computeListDisplayWindow({
        items,
        selectedIndex,
        rowBudget: 7,
        decorations: {
          before: (_item, index) => index % 3 === 0,
          after: (_item, index) => index % 4 === 0,
        },
      });
      const visible = window.visibleSlots
        .filter((slot) => slot.kind === 'item')
        .map((slot) => slot.itemIndex);

      for (const slot of window.visibleSlots) {
        if (slot.kind === 'before' || slot.kind === 'after') {
          expect(visible).toContain(slot.itemIndex);
        }
      }
    }
  });
});

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('computeListDisplayWindow properties', () => {
  it('keeps every item reachable and visible across 200 random configurations', () => {
    const random = seededRandom(20260823);
    const pick = (max: number) => Math.floor(random() * max);
    let pinnedAssertions = 0;

    for (let iteration = 0; iteration < 200; iteration++) {
      const itemCount = 1 + pick(40);
      const sectionCount = 1 + pick(3);
      const list = Array.from({ length: itemCount }, (_, index) => ({
        index,
        scope: `s${Math.floor((index * sectionCount) / itemCount)}`,
      }));
      const rowBudget = 5 + pick(8);
      const pinnedHead = pick(9);
      const decorateBefore = random() < 0.5;
      const decorateAfter = random() < 0.5;
      const withSections = random() < 0.5;
      const config = {
        items: list,
        rowBudget,
        pinnedHead,
        decorations: {
          before: (_item: { index: number }, index: number) => decorateBefore && index % 3 === 0,
          after: (_item: { index: number }, index: number) => decorateAfter && index % 4 === 0,
        },
        ...(withSections
          ? {
              section: {
                by: (item: { scope: string }) => item.scope,
                gapBetweenSections: true,
                headerFor: (scope: string) => scope !== 's1',
              },
            }
          : {}),
      };

      const seen = new Set<number>();
      let selectedIndex = 0;
      for (let step = 0; step <= itemCount; step++) {
        const window = computeListDisplayWindow({ ...config, selectedIndex });
        const visible = window.visibleSlots
          .filter((slot) => slot.kind === 'item')
          .map((slot) => slot.itemIndex);

        expect(visible).toContain(selectedIndex);
        for (const index of visible) seen.add(index);

        for (const slot of window.visibleSlots) {
          if (slot.kind === 'before' || slot.kind === 'after') {
            expect(visible).toContain(slot.itemIndex);
          }
        }

        if (selectedIndex < pinnedHead) {
          const unpinned = computeListDisplayWindow({ ...config, selectedIndex, pinnedHead: 0 });
          expect(window.scrollOffset).toBeLessThanOrEqual(unpinned.scrollOffset);
          const untrimmed = computeListDisplayWindow({ ...config, selectedIndex, rowBudget: 200 });
          const selectedSlot = untrimmed.visibleSlots.findIndex(
            (slot) => slot.kind === 'item' && slot.itemIndex === selectedIndex,
          );
          if (selectedSlot < rowBudget - 1) expect(window.scrollOffset).toBe(0);
          if (window.scrollOffset === 0) {
            const head = visible.slice(0, Math.min(pinnedHead, visible.length));
            expect(head).toEqual([...Array(head.length).keys()]);
          }
          if (unpinned.scrollOffset > 0 && window.scrollOffset === 0) pinnedAssertions++;
        }

        if (selectedIndex === itemCount - 1) break;
        const lastVisible = visible.at(-1) ?? selectedIndex;
        selectedIndex = Math.min(itemCount - 1, Math.max(lastVisible, selectedIndex + 1));
      }

      expect(seen.size).toBe(itemCount);
      expect(selectedIndex).toBe(itemCount - 1);
    }

    expect(pinnedAssertions).toBeGreaterThan(0);
  });
});
