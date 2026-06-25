import { describe, expect, it } from 'vitest';
import { getChromeHeight, TOP_FIXED_CHROME_ROWS } from './chrome-rows.js';
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
  hasWorkflowConfig,
} from './rect.js';

describe('hasWorkflowConfig', () => {
  it('returns true when any workflow-config event is present, false otherwise', () => {
    expect(hasWorkflowConfig([])).toBe(false);
    expect(hasWorkflowConfig([{ type: 'planner_text' }])).toBe(false);
    expect(hasWorkflowConfig([{ type: 'planner_text' }, { type: 'workflow_config' }])).toBe(true);
  });
});

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
      hasConfig: false,
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
    const tall = getWorkflowViewportHeight(30, 4, true);
    expect(tall).toBeGreaterThan(0);

    expect(getWorkflowViewportHeight(5, 20, true)).toBe(0);

    const base = getWorkflowViewportHeight(30, 2, true);
    const withExtraInput = getWorkflowViewportHeight(30, 5, true);
    expect(withExtraInput).toBeLessThan(base);
    expect(base - withExtraInput).toBe(3);

    expect(getWorkflowViewportHeight(30, 2, false)).toBeGreaterThan(
      getWorkflowViewportHeight(30, 2, true),
    );
  });

  it('reserves the footer divider so body height is not one row too tall', () => {
    const rows = 24;
    const inputRows = 2;
    const viewport = getWorkflowViewportHeight(rows, inputRows, false);

    expect(viewport).toBe(rows - getChromeHeight(inputRows, false));

    const legacyBottomFixedWithoutDivider = 2;
    const legacyViewport =
      rows - TOP_FIXED_CHROME_ROWS - legacyBottomFixedWithoutDivider - inputRows;
    expect(viewport).toBe(legacyViewport - 1);
  });

  it('caps prompt rows to the available middle area', () => {
    expect(clampWorkflowPromptRows(10, 3, true, 999)).toBeLessThan(10);
    expect(getWorkflowViewportHeight(10, 3, true, 999)).toBe(0);
  });
});

describe('review column layout', () => {
  it('caps review width and offsets it to the workflow content column', () => {
    expect(getReviewColumnWidth(180)).toBe(120);
    expect(getReviewColumnWidth(80)).toBe(80);

    expect(
      getWorkflowReviewColumn({
        cols: 180,
        sidebarVisible: false,
        isSmall: false,
      }),
    ).toEqual({
      leftOffset: 1,
      width: 120,
    });

    const withSidebar = getWorkflowReviewColumn({
      cols: 180,
      sidebarVisible: true,
      isSmall: false,
    });
    expect(withSidebar.leftOffset).toBeGreaterThan(1);
    expect(withSidebar.width).toBe(120);
  });
});

describe('getWorkflowContentRect', () => {
  it('produces a geometrically consistent rect that agrees with the width/height helpers', () => {
    const cols = 120;
    const rows = 30;
    const inputRows = 4;
    const hasConfig = true;
    const sidebarVisible = true;
    const isSmall = false;

    const rect = getWorkflowContentRect({
      cols,
      rows,
      inputRows,
      hasConfig,
      sidebarVisible,
      isSmall,
    });

    expect(rect.width).toBe(getWorkflowContentWidth({ cols, sidebarVisible, isSmall }));
    expect(rect.height).toBe(getWorkflowViewportHeight(rows, inputRows, hasConfig, 0, cols));

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
      hasConfig: true,
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
      hasConfig: true,
      sidebarVisible: true,
      isSmall: false,
    });

    expect(rect.width).toBe(0);
    expect(rect.height).toBe(0);
    expect(rect.right).toBeGreaterThanOrEqual(rect.left);
    expect(rect.bottom).toBeGreaterThanOrEqual(rect.top);
  });

  it('uses one less top row when config fits inline on wide terminals', () => {
    const narrow = getWorkflowViewportHeight(30, 2, true, 0, 80);
    const wide = getWorkflowViewportHeight(30, 2, true, 0, 120);

    expect(wide).toBe(narrow + 1);
  });
});

describe('getReviewContentLayout', () => {
  it('reserves file header, separator, scroll chrome, and footer when content overflows', () => {
    const fits = getReviewContentLayout(10, 3);
    expect(fits).toEqual({ contentHeight: 6, showFooter: false });

    const overflows = getReviewContentLayout(10, 12);
    expect(overflows).toEqual({ contentHeight: 5, showFooter: true });
    expect(overflows.contentHeight).toBeLessThan(fits.contentHeight);
    expect(2 + 2 + overflows.contentHeight + 1).toBe(10);
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
