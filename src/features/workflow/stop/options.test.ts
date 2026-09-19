import { describe, it, expect } from 'vitest';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { STOP_SHEET_FOOTER, STOP_SHEET_LEGEND, stopMenuLayout, stopSheetRows } from './options.js';

describe('stopSheetRows', () => {
  it('names the brief it would finish and the one it would not start', () => {
    const rows = stopSheetRows({
      currentTaskId: 'T002',
      nextTaskId: 'T003',
      boundaryPauseRequested: false,
    });

    expect(rows.map((row) => row.id)).toEqual(['stop-now', 'pause-after-brief', 'end-run']);
    expect(rows[1]?.label).toBe('Pause after this brief');
    expect(rows[1]?.consequence).toBe('finish T002 including checks and review; do not start T003');
  });

  it('hides the pause row when no brief is running', () => {
    const rows = stopSheetRows({
      currentTaskId: null,
      nextTaskId: null,
      boundaryPauseRequested: false,
    });

    expect(rows.map((row) => row.id)).toEqual(['stop-now', 'end-run']);
  });

  it('offers the way back while a pause is pending', () => {
    const rows = stopSheetRows({
      currentTaskId: 'T002',
      nextTaskId: 'T003',
      boundaryPauseRequested: true,
    });

    expect(rows.map((row) => row.id)).toEqual(['stop-now', 'keep-running', 'end-run']);
    expect(rows[1]?.label).toBe('Keep running');
  });

  it('names the last brief without inventing a successor', () => {
    const rows = stopSheetRows({
      currentTaskId: 'T005',
      nextTaskId: null,
      boundaryPauseRequested: false,
    });

    expect(rows[1]?.consequence).toBe(
      'finish T005 including checks and review; do not start another brief',
    );
  });

  it('promises no revert and only the three navigation keys', () => {
    expect(STOP_SHEET_FOOTER).toBe('Changes and draft stay.');
    expect(STOP_SHEET_LEGEND).toBe('↑↓ select · enter confirm · esc stop · tab back');
  });
});

describe('stopMenuLayout', () => {
  it('takes the composer width at every terminal width, so the two stacked boxes share both edges', () => {
    const rows = stopSheetRows({
      currentTaskId: 'T002',
      nextTaskId: 'T003',
      boundaryPauseRequested: false,
    });

    for (const cols of [60, 120, 220]) {
      expect(stopMenuLayout(rows, cols).width).toBe(getChromeContentWidth(cols));
    }
  });
});
