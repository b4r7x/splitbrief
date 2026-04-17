import { describe, expect, it } from 'vitest';
import {
  getReviewContentHeight,
  getWorkflowContentWidth,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
  hasWorkflowConfig,
} from './workflow-rect.js';

describe('hasWorkflowConfig', () => {
  it('detects workflow-config events', () => {
    expect(hasWorkflowConfig([{
      type: 'workflow-config',
      ts: 0,
      mode: 'standard',
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    }])).toBe(true);
  });

  it('ignores non-config events', () => {
    expect(hasWorkflowConfig([{ type: 'planner-text', ts: 0, text: 'hello' }])).toBe(false);
  });
});

describe('getWorkflowViewportHeight', () => {
  it('subtracts chrome rows and clamps at zero', () => {
    expect(getWorkflowViewportHeight(30, 4, true)).toBeGreaterThan(0);
    expect(getWorkflowViewportHeight(10, 20, false)).toBe(0);
  });
});

describe('getWorkflowContentWidth', () => {
  it('returns full width when sidebar is hidden', () => {
    expect(getWorkflowContentWidth(100, false, false)).toBe(100);
    expect(getWorkflowContentWidth(100, true, true)).toBe(100);
  });

  it('subtracts sidebar width when sidebar is visible on large screens', () => {
    expect(getWorkflowContentWidth(100, true, false)).toBe(75);
  });
});

describe('getWorkflowSidebarWidth', () => {
  it('returns zero when the sidebar is hidden', () => {
    expect(getWorkflowSidebarWidth(100, false, false)).toBe(0);
    expect(getWorkflowSidebarWidth(100, true, true)).toBe(0);
  });

  it('returns a quarter width when the sidebar is visible on large screens', () => {
    expect(getWorkflowSidebarWidth(100, true, false)).toBe(25);
  });
});

describe('getReviewContentHeight', () => {
  it('reserves one line for the file header', () => {
    expect(getReviewContentHeight(10, 3)).toBe(9);
  });

  it('reserves a footer row when the review remains scrollable', () => {
    expect(getReviewContentHeight(10, 12)).toBe(8);
  });

  it('clamps at zero for tiny viewports', () => {
    expect(getReviewContentHeight(1, 20)).toBe(0);
  });
});
