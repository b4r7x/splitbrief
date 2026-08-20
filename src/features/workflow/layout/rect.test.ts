import { describe, expect, it } from 'vitest';
import { getChromeHeight, getContentTopRow } from './chrome-rows.js';
import {
  clampWorkflowPromptRows,
  getReviewContentLayout,
  getReviewColumnWidth,
  getSidebarStatusColumnCells,
  getSidebarTaskListRows,
  getSidebarTaskTitleWidth,
  getSidebarTaskWindow,
  getWorkflowContentRect,
  getWorkflowContentWidth,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
  SIDEBAR_BREAKPOINT_COLS,
  WORKFLOW_SIDEBAR_GAP,
} from './rect.js';

describe('workflow viewport layout', () => {
  it('keeps the sidebar status reservation explicit at the call boundary', () => {
    expect(getSidebarStatusColumnCells({ hasStatusTail: false })).toBe(0);
    expect(getSidebarStatusColumnCells({ hasStatusTail: true })).toBeGreaterThan(0);
  });

  it('splits width between sidebar, gap, and content exactly, only when the sidebar is visible above the breakpoint', () => {
    const cols = 121;

    expect(getWorkflowSidebarWidth({ cols, sidebarVisible: false })).toBe(0);
    expect(getWorkflowContentWidth({ cols, sidebarVisible: false })).toBe(cols);

    expect(getWorkflowSidebarWidth({ cols: 100, sidebarVisible: true })).toBe(0);
    expect(getWorkflowContentWidth({ cols: 100, sidebarVisible: true })).toBe(100);

    const sidebar = getWorkflowSidebarWidth({ cols, sidebarVisible: true });
    const content = getWorkflowContentWidth({ cols, sidebarVisible: true });
    expect(sidebar).toBeGreaterThan(0);
    expect(content).toBeGreaterThan(0);
    expect(WORKFLOW_SIDEBAR_GAP).toBe(2);
    expect(sidebar + WORKFLOW_SIDEBAR_GAP + content).toBe(cols);
  });

  it('hides the sidebar below the workflow breakpoint and clamps its share between a floor and a ceiling above it', () => {
    expect(SIDEBAR_BREAKPOINT_COLS).toBe(120);
    expect(getWorkflowSidebarWidth({ cols: 119, sidebarVisible: true })).toBe(0);
    expect(getWorkflowSidebarWidth({ cols: 120, sidebarVisible: true })).toBe(0);
    expect(getWorkflowSidebarWidth({ cols: 121, sidebarVisible: true })).toBeGreaterThan(0);

    const atBreakpoint = getWorkflowSidebarWidth({ cols: 121, sidebarVisible: true });
    const atMid = getWorkflowSidebarWidth({ cols: 160, sidebarVisible: true });
    const atCap = getWorkflowSidebarWidth({ cols: 200, sidebarVisible: true });
    const atWide = getWorkflowSidebarWidth({ cols: 400, sidebarVisible: true });

    expect(atBreakpoint).toBeGreaterThan(0);
    expect(atMid).toBeGreaterThan(atBreakpoint);
    expect(atCap).toBe(atWide);
    expect(atWide).toBeLessThan(Math.floor(400 * 0.25));
    expect(getWorkflowSidebarWidth({ cols: 400, sidebarVisible: false })).toBe(0);
  });

  it('hands the review column the whole content pane on both sides of the 120/121 breakpoint', () => {
    const below = getWorkflowContentWidth({ cols: 120, sidebarVisible: true });
    const above = getWorkflowContentWidth({ cols: 121, sidebarVisible: true });
    const sidebar = getWorkflowSidebarWidth({ cols: 121, sidebarVisible: true });

    expect(below).toBe(120);
    expect(above).toBe(121 - sidebar - WORKFLOW_SIDEBAR_GAP);
    expect(above).toBeLessThan(below);
    expect(getReviewColumnWidth(below)).toBe(below);
    expect(getReviewColumnWidth(above)).toBe(above);
  });

  it('keeps sidebar plus gap plus content equal to the terminal width at every viewport', () => {
    for (const cols of [121, 160, 400]) {
      const sidebar = getWorkflowSidebarWidth({ cols, sidebarVisible: true });
      const content = getWorkflowContentWidth({ cols, sidebarVisible: true });
      expect(sidebar + WORKFLOW_SIDEBAR_GAP + content).toBe(cols);
    }
  });

  it('gives the task title the interior of the box the row paints into, and less when a status tail reserves cells', () => {
    const width = 48;
    expect(getSidebarTaskTitleWidth({ width, reservedTailCells: 0 })).toBe(width - 7);
    const withTail = getSidebarTaskTitleWidth({ width, reservedTailCells: 5 });
    expect(withTail).toBe(width - 7 - 5);
    expect(withTail).toBeLessThan(getSidebarTaskTitleWidth({ width, reservedTailCells: 0 }));
  });

  it('never shrinks the task title below a readable minimum', () => {
    expect(getSidebarTaskTitleWidth({ width: 10, reservedTailCells: 0 })).toBeGreaterThan(0);
    expect(getSidebarTaskTitleWidth({ width: 10, reservedTailCells: 20 })).toBe(
      getSidebarTaskTitleWidth({ width: 10, reservedTailCells: 0 }),
    );
  });

  it('subtracts chrome + input rows from viewport height and clamps at zero', () => {
    expect(getWorkflowViewportHeight({ rows: 24, inputRows: 2 })).toBe(17);

    const tall = getWorkflowViewportHeight({ rows: 30, inputRows: 4 });
    expect(tall).toBeGreaterThan(0);

    expect(getWorkflowViewportHeight({ rows: 5, inputRows: 20 })).toBe(0);

    const base = getWorkflowViewportHeight({ rows: 30, inputRows: 2 });
    const withExtraInput = getWorkflowViewportHeight({ rows: 30, inputRows: 5 });
    expect(withExtraInput).toBeLessThan(base);
    expect(base - withExtraInput).toBe(3);
  });

  it('reserves the footer divider so the body is not too tall', () => {
    const rows = 24;
    const inputRows = 2;
    const viewport = getWorkflowViewportHeight({ rows, inputRows });

    expect(viewport).toBe(rows - getChromeHeight(inputRows));

    // Legacy bottom chrome was feedback (1) + a one-row footer (1), with no divider. The modern
    // bottom adds the divider; the one-row byline hugs the terminal bottom, so the body is one row
    // shorter than legacy.
    const legacyBottomFixedWithoutDivider = 2;
    const legacyViewport = rows - 2 - legacyBottomFixedWithoutDivider - inputRows;
    expect(viewport).toBe(legacyViewport - 1);
  });

  it('caps prompt rows to the available middle area', () => {
    expect(clampWorkflowPromptRows({ rows: 10, inputRows: 3, promptRows: 999 })).toBeLessThan(10);
    expect(getWorkflowViewportHeight({ rows: 10, inputRows: 3, promptRows: 999 })).toBe(0);
  });

  it('uses one exact breakpoint and one body bottom row across all required widths', () => {
    const rows = 30;
    const inputRows = 3;
    const contentHeight = getWorkflowViewportHeight({ rows, inputRows });

    for (const cols of [121, 120, 119, 80, 50, 40]) {
      const sidebarWidth = getWorkflowSidebarWidth({ cols, sidebarVisible: true });
      const expectedSidebar = cols > SIDEBAR_BREAKPOINT_COLS;

      expect(sidebarWidth > 0).toBe(expectedSidebar);
      expect(getWorkflowContentWidth({ cols, sidebarVisible: true })).toBe(
        expectedSidebar ? cols - sidebarWidth - WORKFLOW_SIDEBAR_GAP : cols,
      );
      expect(getWorkflowContentRect({ cols, rows, inputRows, sidebarVisible: true }).bottom).toBe(
        getContentTopRow() + contentHeight - 1,
      );
    }
  });

  it('clamps zero, one, and starved content rows without producing a negative rectangle', () => {
    const inputRows = 4;
    const chrome = getChromeHeight(inputRows);
    const top = getContentTopRow();
    const rectAt = (rows: number) =>
      getWorkflowContentRect({ cols: 100, rows, inputRows, sidebarVisible: false });

    expect(rectAt(chrome - 3)).toMatchObject({ height: 0, top, bottom: top });
    expect(rectAt(chrome)).toMatchObject({ height: 0, top, bottom: top });
    expect(rectAt(chrome + 1)).toMatchObject({ height: 1, top, bottom: top });
    expect(rectAt(chrome + 2)).toMatchObject({ height: 2, top, bottom: top + 1 });
  });
});

describe('review document layout', () => {
  it('spans the full workflow content width', () => {
    expect(getReviewColumnWidth(180)).toBe(180);
    expect(getReviewColumnWidth(80)).toBe(80);
  });
});

describe('getWorkflowContentRect', () => {
  it('produces a geometrically consistent rect that agrees with the width/height helpers', () => {
    const cols = 121;
    const rows = 30;
    const inputRows = 4;
    const sidebarVisible = true;

    const rect = getWorkflowContentRect({
      cols,
      rows,
      inputRows,
      sidebarVisible,
    });

    expect(rect.width).toBe(getWorkflowContentWidth({ cols, sidebarVisible }));
    const contentHeight = getWorkflowViewportHeight({ rows, inputRows, promptRows: 0 });
    expect(rect.height).toBe(contentHeight);

    expect(rect.right).toBe(rect.left + rect.width - 1);
    expect(rect.bottom).toBe(rect.top + rect.height - 1);

    const sidebarWidth = getWorkflowSidebarWidth({ cols, sidebarVisible });
    expect(rect.left).toBe(sidebarWidth + WORKFLOW_SIDEBAR_GAP + 1);
  });

  it('when the sidebar is hidden the flush rect starts at the terminal edge and takes full width', () => {
    const rect = getWorkflowContentRect({
      cols: 100,
      rows: 30,
      inputRows: 2,
      sidebarVisible: false,
    });
    expect(rect.left).toBe(1);
    expect(rect.width).toBe(100);
  });

  it('keeps edges non-inverted when the terminal has no usable content area', () => {
    const rect = getWorkflowContentRect({
      cols: 0,
      rows: 0,
      inputRows: 20,
      sidebarVisible: true,
    });

    expect(rect.width).toBe(0);
    expect(rect.height).toBe(0);
    expect(rect.right).toBeGreaterThanOrEqual(rect.left);
    expect(rect.bottom).toBeGreaterThanOrEqual(rect.top);
  });

  it('keeps the content top row fixed at every body height', () => {
    const oneRow = getWorkflowContentRect({
      cols: 100,
      rows: 8,
      inputRows: 2,
      sidebarVisible: false,
    });
    const twoRows = getWorkflowContentRect({
      cols: 100,
      rows: 9,
      inputRows: 2,
      sidebarVisible: false,
    });

    expect(oneRow.height).toBe(1);
    expect(oneRow.top).toBe(getContentTopRow());
    expect(oneRow.bottom).toBe(oneRow.top);
    expect(twoRows.height).toBe(2);
    expect(twoRows.top).toBe(getContentTopRow());
  });
});

describe('getReviewContentLayout', () => {
  it('reserves the title header and the divider+line footer when content overflows', () => {
    const fits = getReviewContentLayout(10, 3);
    expect(fits).toEqual({ contentHeight: 8, showFooter: false });

    const overflows = getReviewContentLayout(10, 12);
    expect(overflows).toEqual({ contentHeight: 6, showFooter: true });
    expect(overflows.contentHeight).toBeLessThan(fits.contentHeight);
    expect(2 + overflows.contentHeight + 2).toBe(10);
  });

  it('does not show a footer when the container only has room for review chrome', () => {
    expect(getReviewContentLayout(2, 20)).toEqual({
      contentHeight: 0,
      showFooter: false,
    });
    expect(getReviewContentLayout(1, 20).contentHeight).toBe(0);
    expect(getReviewContentLayout(0, 0).contentHeight).toBe(0);
  });
});

describe('sidebar task list geometry', () => {
  it('leaves the list every row the sidebar chrome and footer do not claim', () => {
    expect(getSidebarTaskListRows({ height: 24, footerRows: 3 })).toBe(16);
    expect(getSidebarTaskListRows({ height: 24, footerRows: 4 })).toBe(15);
    expect(getSidebarTaskListRows({ height: 5, footerRows: 3 })).toBe(0);
    expect(getSidebarTaskListRows({ height: 0, footerRows: 0 })).toBe(0);
  });

  it('shows the whole list when it fits', () => {
    expect(getSidebarTaskWindow({ itemCount: 4, anchorIndex: 2, rows: 8 })).toEqual({
      start: 0,
      end: 4,
      hiddenAbove: 0,
      hiddenBelow: 0,
      showAbove: false,
      showBelow: false,
      combine: false,
    });
  });

  it('keeps the anchor visible and never exceeds the row budget when the list overflows', () => {
    for (const rows of [1, 2, 3, 5, 8, 13]) {
      for (let anchor = 0; anchor < 20; anchor += 1) {
        const window = getSidebarTaskWindow({ itemCount: 20, anchorIndex: anchor, rows });
        const visible = window.end - window.start;
        const used =
          visible +
          (window.showAbove ? 1 : 0) +
          (window.showBelow ? 1 : 0) +
          (window.combine ? 1 : 0);

        expect(used, `rows ${rows} anchor ${anchor}`).toBeLessThanOrEqual(rows);
        expect(visible, `rows ${rows} anchor ${anchor}`).toBeGreaterThan(0);
        expect(window.hiddenAbove + visible + window.hiddenBelow).toBe(20);
        expect(anchor, `anchor ${anchor} outside window at rows ${rows}`).toBeGreaterThanOrEqual(
          window.start,
        );
        expect(anchor).toBeLessThan(window.end);
      }
    }
  });

  it('drops the overflow markers rather than the only task row it can show', () => {
    expect(getSidebarTaskWindow({ itemCount: 20, anchorIndex: 9, rows: 1 })).toEqual({
      start: 9,
      end: 10,
      hiddenAbove: 9,
      hiddenBelow: 10,
      showAbove: false,
      showBelow: false,
      combine: false,
    });
  });

  it('collapses both markers into one row rather than hiding an overflowing edge', () => {
    // Two rows buy one task row and one marker row. Spending that marker on a single edge would
    // leave the other edge silently truncated, so the one row has to name both.
    expect(getSidebarTaskWindow({ itemCount: 20, anchorIndex: 9, rows: 2 })).toEqual({
      start: 9,
      end: 10,
      hiddenAbove: 9,
      hiddenBelow: 10,
      showAbove: false,
      showBelow: false,
      combine: true,
    });
  });

  it('never leaves an overflowing edge unreported once it can afford a marker row', () => {
    for (const rows of [2, 3, 5, 8, 13]) {
      for (let anchor = 0; anchor < 20; anchor += 1) {
        const window = getSidebarTaskWindow({ itemCount: 20, anchorIndex: anchor, rows });
        const reported = window.combine || (window.showAbove && window.showBelow);

        if (window.hiddenAbove > 0 && window.hiddenBelow > 0) {
          expect(reported, `rows ${rows} anchor ${anchor} hides an edge`).toBe(true);
        }
      }
    }
  });

  it('anchors to the top and the bottom without wasting a marker row', () => {
    expect(getSidebarTaskWindow({ itemCount: 10, anchorIndex: 0, rows: 4 })).toEqual({
      start: 0,
      end: 3,
      hiddenAbove: 0,
      hiddenBelow: 7,
      showAbove: false,
      showBelow: true,
      combine: false,
    });
    expect(getSidebarTaskWindow({ itemCount: 10, anchorIndex: 9, rows: 4 })).toEqual({
      start: 7,
      end: 10,
      hiddenAbove: 7,
      hiddenBelow: 0,
      showAbove: true,
      showBelow: false,
      combine: false,
    });
  });

  it('returns an empty window when there is no room or nothing to show', () => {
    expect(getSidebarTaskWindow({ itemCount: 5, anchorIndex: 2, rows: 0 })).toEqual({
      start: 0,
      end: 0,
      hiddenAbove: 0,
      hiddenBelow: 5,
      showAbove: false,
      showBelow: false,
      combine: false,
    });
    expect(getSidebarTaskWindow({ itemCount: 0, anchorIndex: 0, rows: 6 })).toEqual({
      start: 0,
      end: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
      showAbove: false,
      showBelow: false,
      combine: false,
    });
  });
});
