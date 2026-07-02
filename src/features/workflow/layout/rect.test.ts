import { describe, expect, it } from 'vitest';
import { getChromeHeight, getContentTopRow, TOP_FIXED_CHROME_ROWS } from './chrome-rows.js';
import {
  clampWorkflowPromptRows,
  getReviewContentLayout,
  getReviewColumnWidth,
  getWorkflowContentRect,
  getWorkflowContentWidth,
  getWorkflowReviewColumn,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
  WORKFLOW_SIDEBAR_GAP,
} from './rect.js';

describe('workflow viewport layout', () => {
  it('splits width between sidebar, gap, and content exactly, only when sidebar is visible on large screens', () => {
    const cols = 120;

    expect(getWorkflowSidebarWidth({ cols, sidebarVisible: false, isSmall: false })).toBe(0);
    expect(getWorkflowContentWidth({ cols, sidebarVisible: false, isSmall: false })).toBe(cols);

    expect(getWorkflowSidebarWidth({ cols, sidebarVisible: true, isSmall: true })).toBe(0);
    expect(getWorkflowContentWidth({ cols, sidebarVisible: true, isSmall: true })).toBe(cols);

    const sidebar = getWorkflowSidebarWidth({
      cols,
      sidebarVisible: true,
      isSmall: false,
    });
    const content = getWorkflowContentWidth({
      cols,
      sidebarVisible: true,
      isSmall: false,
    });
    expect(sidebar).toBeGreaterThan(0);
    expect(content).toBeGreaterThan(0);
    expect(sidebar + WORKFLOW_SIDEBAR_GAP + content).toBe(cols);
  });

  it('reserves the two-column gap only while the sidebar is visible', () => {
    const cols = 120;
    expect(WORKFLOW_SIDEBAR_GAP).toBe(2);

    const withSidebar = getWorkflowContentWidth({ cols, sidebarVisible: true, isSmall: false });
    const sidebar = getWorkflowSidebarWidth({ cols, sidebarVisible: true, isSmall: false });
    expect(withSidebar).toBe(cols - sidebar - WORKFLOW_SIDEBAR_GAP);

    // No sidebar → no gap: the content pane spans the full terminal width.
    expect(getWorkflowContentWidth({ cols, sidebarVisible: false, isSmall: false })).toBe(cols);
  });

  it('subtracts chrome + input rows from viewport height and clamps at zero', () => {
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
    const legacyViewport =
      rows - TOP_FIXED_CHROME_ROWS - legacyBottomFixedWithoutDivider - inputRows;
    expect(viewport).toBe(legacyViewport - 1);
  });

  it('caps prompt rows to the available middle area', () => {
    expect(clampWorkflowPromptRows({ rows: 10, inputRows: 3, promptRows: 999 })).toBeLessThan(10);
    expect(getWorkflowViewportHeight({ rows: 10, inputRows: 3, promptRows: 999 })).toBe(0);
  });
});

describe('review column layout', () => {
  it('spans the full content width and offsets it to the workflow content column', () => {
    expect(getReviewColumnWidth(180)).toBe(180);
    expect(getReviewColumnWidth(80)).toBe(80);

    expect(
      getWorkflowReviewColumn({
        cols: 180,
        sidebarVisible: false,
        isSmall: false,
      }),
    ).toEqual({
      leftOffset: 0,
      width: getWorkflowContentWidth({ cols: 180, sidebarVisible: false, isSmall: false }),
    });

    const withSidebar = getWorkflowReviewColumn({
      cols: 180,
      sidebarVisible: true,
      isSmall: false,
    });
    // The review column starts past the sidebar and its two-column gap so it aligns with the
    // conversation pane.
    expect(withSidebar.leftOffset).toBe(
      getWorkflowSidebarWidth({ cols: 180, sidebarVisible: true, isSmall: false }) +
        WORKFLOW_SIDEBAR_GAP,
    );
    expect(withSidebar.width).toBe(
      getWorkflowContentWidth({ cols: 180, sidebarVisible: true, isSmall: false }),
    );
  });
});

describe('getWorkflowContentRect', () => {
  it('produces a geometrically consistent rect that agrees with the width/height helpers', () => {
    const cols = 120;
    const rows = 30;
    const inputRows = 4;
    const sidebarVisible = true;
    const isSmall = false;

    const rect = getWorkflowContentRect({
      cols,
      rows,
      inputRows,
      sidebarVisible,
      isSmall,
    });

    expect(rect.width).toBe(getWorkflowContentWidth({ cols, sidebarVisible, isSmall }));
    expect(rect.height).toBe(getWorkflowViewportHeight({ rows, inputRows, promptRows: 0 }));

    expect(rect.right).toBe(rect.left + rect.width - 1);
    expect(rect.bottom).toBe(rect.top + rect.height - 1);

    const sidebarWidth = getWorkflowSidebarWidth({
      cols,
      sidebarVisible,
      isSmall,
    });
    expect(rect.left).toBe(sidebarWidth + WORKFLOW_SIDEBAR_GAP + 1);
  });

  it('when the sidebar is hidden the flush rect starts at the terminal edge and takes full width', () => {
    const rect = getWorkflowContentRect({
      cols: 100,
      rows: 30,
      inputRows: 2,
      sidebarVisible: false,
      isSmall: false,
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
      isSmall: false,
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
      isSmall: false,
    });
    const twoRows = getWorkflowContentRect({
      cols: 100,
      rows: 9,
      inputRows: 2,
      sidebarVisible: false,
      isSmall: false,
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
