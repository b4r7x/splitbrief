import { describe, expect, it } from 'vitest';
import {
  getChromeHeight,
  getContentTopRow,
  RAIL_ACTIVE_EXTRA_ROWS,
  TOP_FIXED_CHROME_ROWS,
} from './chrome-rows.js';
import {
  clampWorkflowPromptRows,
  getReviewContentLayout,
  getReviewColumnWidth,
  getWorkflowConversationRect,
  getWorkflowContentRect,
  getWorkflowContentWidth,
  getWorkflowReviewColumn,
  getWorkflowRuntimeLayout,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
} from './rect.js';

describe('getWorkflowRuntimeLayout', () => {
  it('keeps runtime layouts full width without an activity rail on compact terminals', () => {
    expect(getWorkflowRuntimeLayout({ contentWidth: 98 })).toEqual({
      conversationWidth: 98,
      contentWidth: 98,
    });
  });

  it('keeps wide runtime layouts full width (activity rail removed)', () => {
    expect(getWorkflowRuntimeLayout({ contentWidth: 118 })).toEqual({
      conversationWidth: 118,
      contentWidth: 118,
    });
  });

  it('returns a conversation rect that matches the rendered conversation width', () => {
    const contentRect = getWorkflowContentRect({
      cols: 120,
      rows: 30,
      inputRows: 2,
      railExtraRows: 0,
      sidebarVisible: false,
      isSmall: false,
    });
    const runtime = getWorkflowRuntimeLayout({
      contentWidth: contentRect.width,
    });
    const conversationRect = getWorkflowConversationRect(contentRect, runtime);

    expect(conversationRect.width).toBe(runtime.conversationWidth);
    expect(conversationRect.left).toBe(contentRect.left);
    expect(conversationRect.right).toBe(conversationRect.left + runtime.conversationWidth - 1);
  });
});

describe('workflow viewport layout', () => {
  it('splits width between sidebar and content exactly, only when sidebar is visible on large screens', () => {
    const cols = 120;

    expect(getWorkflowSidebarWidth({ cols, sidebarVisible: false, isSmall: false })).toBe(0);
    expect(getWorkflowContentWidth({ cols, sidebarVisible: false, isSmall: false })).toBe(cols - 2);

    expect(getWorkflowSidebarWidth({ cols, sidebarVisible: true, isSmall: true })).toBe(0);
    expect(getWorkflowContentWidth({ cols, sidebarVisible: true, isSmall: true })).toBe(cols - 2);

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
    expect(sidebar + content).toBe(cols - 2);
  });

  it('subtracts chrome + input rows from viewport height and clamps at zero', () => {
    const tall = getWorkflowViewportHeight(30, 4, 0);
    expect(tall).toBeGreaterThan(0);

    expect(getWorkflowViewportHeight(5, 20, 0)).toBe(0);

    const base = getWorkflowViewportHeight(30, 2, 0);
    const withExtraInput = getWorkflowViewportHeight(30, 5, 0);
    expect(withExtraInput).toBeLessThan(base);
    expect(base - withExtraInput).toBe(3);

    expect(getWorkflowViewportHeight(30, 2, 0)).toBeGreaterThan(
      getWorkflowViewportHeight(30, 2, RAIL_ACTIVE_EXTRA_ROWS),
    );
  });

  it('the active activity row steals exactly its extra rows from the transcript', () => {
    const formB = getWorkflowViewportHeight(30, 2, 0);
    const formA = getWorkflowViewportHeight(30, 2, RAIL_ACTIVE_EXTRA_ROWS);
    expect(formB - formA).toBe(RAIL_ACTIVE_EXTRA_ROWS);
  });

  it('reserves the footer divider and the byline breathing row so the body is not too tall', () => {
    const rows = 24;
    const inputRows = 2;
    const viewport = getWorkflowViewportHeight(rows, inputRows, 0);

    expect(viewport).toBe(rows - getChromeHeight(inputRows, 0));

    // Legacy bottom chrome was feedback (1) + a one-row footer (1), with no divider and no byline
    // breathing row. The modern bottom adds both, so the body is two rows shorter than legacy.
    const legacyBottomFixedWithoutDivider = 2;
    const legacyViewport =
      rows - TOP_FIXED_CHROME_ROWS - legacyBottomFixedWithoutDivider - inputRows;
    expect(viewport).toBe(legacyViewport - 2);
  });

  it('caps prompt rows to the available middle area', () => {
    expect(clampWorkflowPromptRows(10, 3, 0, 999)).toBeLessThan(10);
    expect(getWorkflowViewportHeight(10, 3, 0, 999)).toBe(0);
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
      leftOffset: 1,
      width: getWorkflowContentWidth({ cols: 180, sidebarVisible: false, isSmall: false }),
    });

    const withSidebar = getWorkflowReviewColumn({
      cols: 180,
      sidebarVisible: true,
      isSmall: false,
    });
    expect(withSidebar.leftOffset).toBeGreaterThan(1);
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
    const railExtraRows = RAIL_ACTIVE_EXTRA_ROWS;
    const sidebarVisible = true;
    const isSmall = false;

    const rect = getWorkflowContentRect({
      cols,
      rows,
      inputRows,
      railExtraRows,
      sidebarVisible,
      isSmall,
    });

    expect(rect.width).toBe(getWorkflowContentWidth({ cols, sidebarVisible, isSmall }));
    expect(rect.height).toBe(getWorkflowViewportHeight(rows, inputRows, railExtraRows, 0));

    expect(rect.right).toBe(rect.left + rect.width - 1);
    expect(rect.bottom).toBe(rect.top + rect.height - 1);

    const sidebarWidth = getWorkflowSidebarWidth({
      cols,
      sidebarVisible,
      isSmall,
    });
    expect(rect.left).toBe(sidebarWidth + 2);
  });

  it('when the sidebar is hidden the rect starts after body padding and takes padded width', () => {
    const rect = getWorkflowContentRect({
      cols: 100,
      rows: 30,
      inputRows: 2,
      railExtraRows: 0,
      sidebarVisible: false,
      isSmall: false,
    });
    expect(rect.left).toBe(2);
    expect(rect.width).toBe(98);
  });

  it('keeps edges non-inverted when the terminal has no usable content area', () => {
    const rect = getWorkflowContentRect({
      cols: 0,
      rows: 0,
      inputRows: 20,
      railExtraRows: 0,
      sidebarVisible: true,
      isSmall: false,
    });

    expect(rect.width).toBe(0);
    expect(rect.height).toBe(0);
    expect(rect.right).toBeGreaterThanOrEqual(rect.left);
    expect(rect.bottom).toBeGreaterThanOrEqual(rect.top);
  });

  it('targets the only visible row, not the dropped top gap, at a one-row body height', () => {
    const rect = getWorkflowContentRect({
      cols: 100,
      rows: 12,
      inputRows: 2,
      railExtraRows: 0,
      sidebarVisible: false,
      isSmall: false,
    });

    expect(rect.height).toBe(1);
    // The body renders its lone row flush against the chrome (no top gap), so hit testing must
    // place the content one row above the gap-present geometry.
    expect(rect.top).toBe(getContentTopRow(0) - 1);
    expect(rect.bottom).toBe(rect.top);

    const inRect = (row: number) => row >= rect.top && row <= rect.bottom;
    expect(inRect(rect.top)).toBe(true);
    expect(inRect(getContentTopRow(0))).toBe(false);
  });

  it('keeps the top gap reserved once a second content row is visible', () => {
    const rect = getWorkflowContentRect({
      cols: 100,
      rows: 13,
      inputRows: 2,
      railExtraRows: 0,
      sidebarVisible: false,
      isSmall: false,
    });

    expect(rect.height).toBe(2);
    expect(rect.top).toBe(getContentTopRow(0));
  });

  it('starts the content lower when the active activity row is shown', () => {
    const formB = getWorkflowContentRect({
      cols: 100,
      rows: 40,
      inputRows: 2,
      railExtraRows: 0,
      sidebarVisible: false,
      isSmall: false,
    });
    const formA = getWorkflowContentRect({
      cols: 100,
      rows: 40,
      inputRows: 2,
      railExtraRows: RAIL_ACTIVE_EXTRA_ROWS,
      sidebarVisible: false,
      isSmall: false,
    });

    expect(formA.top - formB.top).toBe(RAIL_ACTIVE_EXTRA_ROWS);
    expect(formB.height - formA.height).toBe(RAIL_ACTIVE_EXTRA_ROWS);
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
