import { describe, expect, it } from 'vitest';
import { buildProgressRowCount, getChromeContentWidth, getChromeHeight } from './chrome-rows.js';
import { workflowScreenLayout } from './screen-layout.js';

const atRest = {
  cols: 100,
  rows: 30,
  inputRows: 1,
  sidebarVisible: true,
  requestedPromptRows: 0,
  phase: 'planning' as const,
  cancelled: false,
  halted: false,
  atRest: true,
  parked: false,
};

describe('workflowScreenLayout', () => {
  it('gives the panel the rows it asks for and the transcript the rest of the middle', () => {
    const middle = atRest.rows - getChromeHeight(atRest.inputRows, 0);
    expect(workflowScreenLayout({ ...atRest, requestedPromptRows: 4 })).toMatchObject({
      progressRows: 0,
      promptBoxRows: 4,
      contentHeight: middle - 4,
    });
  });

  it('keeps one row for an open panel while the chrome fits, and none once the chrome overflows', () => {
    const chrome = getChromeHeight(atRest.inputRows, 0);
    expect(workflowScreenLayout({ ...atRest, rows: chrome, requestedPromptRows: 4 })).toMatchObject(
      { promptBoxRows: 1, contentHeight: 0 },
    );
    expect(
      workflowScreenLayout({ ...atRest, rows: chrome - 1, requestedPromptRows: 4 }),
    ).toMatchObject({ promptBoxRows: 0, contentHeight: 0 });
  });

  it('paints the build block only while a brief builds and no panel asks for rows', () => {
    const building = { ...atRest, phase: 'implementing' as const, atRest: false };
    const blockRows = buildProgressRowCount(getChromeContentWidth(building.cols));
    const middle = building.rows - getChromeHeight(building.inputRows, blockRows);
    expect(workflowScreenLayout(building)).toMatchObject({
      progressRows: blockRows,
      promptBoxRows: 0,
      contentHeight: middle,
    });
    expect(workflowScreenLayout({ ...building, requestedPromptRows: 2 }).progressRows).toBe(0);
    expect(workflowScreenLayout({ ...building, halted: true }).progressRows).toBe(0);
    expect(workflowScreenLayout({ ...building, parked: true }).progressRows).toBe(0);
    expect(workflowScreenLayout({ ...building, cancelled: true }).progressRows).toBe(0);
  });

  it('opens the sidebar only when it is shown on a terminal past the breakpoint, and narrows the transcript by it', () => {
    const narrow = workflowScreenLayout({ ...atRest, cols: 100 });
    const wide = workflowScreenLayout({ ...atRest, cols: 160 });
    const hidden = workflowScreenLayout({ ...atRest, cols: 160, sidebarVisible: false });
    expect(narrow.sidebarWidth).toBe(0);
    expect(hidden.sidebarWidth).toBe(0);
    expect(wide.sidebarWidth).toBeGreaterThan(0);
    expect(hidden.contentWidth - wide.contentWidth).toBeGreaterThan(wide.sidebarWidth);
  });
});
