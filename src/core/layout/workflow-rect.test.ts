import { describe, expect, it } from 'vitest';
import {
  getReviewContentHeight,
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
    expect(
      hasWorkflowConfig([
        { type: 'planner_text' },
        { type: 'workflow_config' },
      ]),
    ).toBe(true);
  });
});

describe('workflow viewport layout', () => {
  it('splits width between sidebar and content exactly, only when sidebar is visible on large screens', () => {
    const cols = 120;

    // Sidebar hidden — full width to content, no sidebar
    expect(getWorkflowSidebarWidth(cols, false, false)).toBe(0);
    expect(getWorkflowContentWidth(cols, false, false)).toBe(cols);

    // Small screen — sidebar collapses even when requested
    expect(getWorkflowSidebarWidth(cols, true, true)).toBe(0);
    expect(getWorkflowContentWidth(cols, true, true)).toBe(cols);

    // Visible + large — sidebar + content partition cols with no gap/overlap
    const sidebar = getWorkflowSidebarWidth(cols, true, false);
    const content = getWorkflowContentWidth(cols, true, false);
    expect(sidebar).toBeGreaterThan(0);
    expect(content).toBeGreaterThan(0);
    expect(sidebar + content).toBe(cols);
  });

  it('subtracts chrome + input rows from viewport height and clamps at zero', () => {
    // Enough vertical space — viewport fits under chrome
    const tall = getWorkflowViewportHeight(30, 4, true);
    expect(tall).toBeGreaterThan(0);

    // Terminal shorter than the required chrome — clamps at 0 rather than going negative
    expect(getWorkflowViewportHeight(5, 20, true)).toBe(0);

    // More input rows always shrink the viewport (monotonic)
    const base = getWorkflowViewportHeight(30, 2, true);
    const withExtraInput = getWorkflowViewportHeight(30, 5, true);
    expect(withExtraInput).toBeLessThan(base);
    expect(base - withExtraInput).toBe(3);

    // Showing the config chrome also shrinks the viewport
    expect(getWorkflowViewportHeight(30, 2, false)).toBeGreaterThan(
      getWorkflowViewportHeight(30, 2, true),
    );
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

    const rect = getWorkflowContentRect({ cols, rows, inputRows, hasConfig, sidebarVisible, isSmall });

    // width/height match the dedicated helpers
    expect(rect.width).toBe(getWorkflowContentWidth(cols, sidebarVisible, isSmall));
    expect(rect.height).toBe(getWorkflowViewportHeight(rows, inputRows, hasConfig));

    // right/bottom are inclusive edges of a rect described by left/top + width/height
    expect(rect.right).toBe(rect.left + rect.width - 1);
    expect(rect.bottom).toBe(rect.top + rect.height - 1);

    // Content sits after the sidebar when it is visible (leaves one gap column), otherwise at col 1
    const sidebarWidth = getWorkflowSidebarWidth(cols, sidebarVisible, isSmall);
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
});

describe('getReviewContentHeight', () => {
  it('reserves a header row always and an extra footer row only when content overflows', () => {
    // Content fits — only the header row is reserved
    const fits = getReviewContentHeight(10, 3);
    expect(fits).toBe(10 - 1);

    // Content overflows — an additional footer row is reserved for the scroll indicator
    const overflows = getReviewContentHeight(10, 12);
    expect(overflows).toBe(10 - 1 - 1);
    expect(overflows).toBeLessThan(fits);

    // Tiny container — clamps to 0 rather than going negative
    expect(getReviewContentHeight(1, 20)).toBe(0);
    expect(getReviewContentHeight(0, 0)).toBe(0);
  });
});
