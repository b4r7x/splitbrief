import { describe, expect, it } from 'vitest';
import {
  clampWorkflowPromptRows,
  getReviewContentLayout,
  getWorkflowContentRect,
  getWorkflowContentWidth,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
  hasWorkflowConfig,
} from './workflow-rect.js';

describe('hasWorkflowConfig', () => {
  it('returns true when any workflow-config event is present, false otherwise', () => {
    expect(hasWorkflowConfig([])).toBe(false);
    expect(hasWorkflowConfig([{ type: 'planner_text' }])).toBe(false);
    expect(hasWorkflowConfig([{ type: 'planner_text' }, { type: 'workflow_config' }])).toBe(true);
  });
});

describe('workflow viewport layout', () => {
  it('splits width between sidebar and content exactly, only when sidebar is visible on large screens', () => {
    const cols = 120;

    expect(getWorkflowSidebarWidth({ cols, sidebarVisible: false, isSmall: false })).toBe(0);
    expect(getWorkflowContentWidth({ cols, sidebarVisible: false, isSmall: false })).toBe(cols);

    expect(getWorkflowSidebarWidth({ cols, sidebarVisible: true, isSmall: true })).toBe(0);
    expect(getWorkflowContentWidth({ cols, sidebarVisible: true, isSmall: true })).toBe(cols);

    const sidebar = getWorkflowSidebarWidth({ cols, sidebarVisible: true, isSmall: false });
    const content = getWorkflowContentWidth({ cols, sidebarVisible: true, isSmall: false });
    expect(sidebar).toBeGreaterThan(0);
    expect(content).toBeGreaterThan(0);
    expect(sidebar + content).toBe(cols);
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

  it('caps prompt rows to the available middle area', () => {
    expect(clampWorkflowPromptRows(10, 3, true, 999)).toBeLessThan(10);
    expect(getWorkflowViewportHeight(10, 3, true, 999)).toBe(0);
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

    const sidebarWidth = getWorkflowSidebarWidth({ cols, sidebarVisible, isSmall });
    expect(rect.left).toBe(sidebarWidth + 1);
  });

  it('when the sidebar is hidden the rect starts at column 1 and takes full width', () => {
    const rect = getWorkflowContentRect({
      cols: 100,
      rows: 30,
      inputRows: 2,
      hasConfig: true,
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
  it('reserves file header and separator rows, plus a footer row when content overflows', () => {
    const fits = getReviewContentLayout(10, 3);
    expect(fits).toEqual({ contentHeight: 8, showFooter: false });

    const overflows = getReviewContentLayout(10, 12);
    expect(overflows).toEqual({ contentHeight: 7, showFooter: true });
    expect(overflows.contentHeight).toBeLessThan(fits.contentHeight);
    expect(2 + overflows.contentHeight + 1).toBe(10);
  });

  it('does not show a footer when the container only has room for review chrome', () => {
    expect(getReviewContentLayout(2, 20)).toEqual({ contentHeight: 0, showFooter: false });
    expect(getReviewContentLayout(1, 20).contentHeight).toBe(0);
    expect(getReviewContentLayout(0, 0).contentHeight).toBe(0);
  });
});
