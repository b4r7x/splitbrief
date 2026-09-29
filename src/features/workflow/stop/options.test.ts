import { describe, it, expect } from 'vitest';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import {
  STOP_SHEET_FOOTER,
  STOP_SHEET_LEGEND,
  stopMenuLayout,
  stopSheetFooter,
  stopSheetRows,
} from './options.js';

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

  it('promises only the draft before a brief has run', () => {
    expect(stopSheetFooter({ hasChanges: false })).toBe('Draft stays.');
    expect(stopSheetFooter({ hasChanges: true })).toBe(STOP_SHEET_FOOTER);
  });

  it('claims partial changes on Stop now only while a brief runs', () => {
    const idle = stopSheetRows({
      currentTaskId: null,
      nextTaskId: null,
      boundaryPauseRequested: false,
    });
    const building = stopSheetRows({
      currentTaskId: 'T002',
      nextTaskId: 'T003',
      boundaryPauseRequested: false,
      hasChanges: true,
    });

    expect(idle[0]?.consequence).toBe('stop execution; keep the run open');
    expect(building[0]?.consequence).toBe('stop execution; keep partial changes');
  });

  it('claims kept changes on End run only once a brief has run', () => {
    const rows = (input: { hasChanges: boolean }) =>
      stopSheetRows({
        currentTaskId: null,
        nextTaskId: null,
        boundaryPauseRequested: false,
        hasChanges: input.hasChanges,
      });

    expect(rows({ hasChanges: false }).at(-1)?.consequence).toBe('stop execution; close this run');
    expect(rows({ hasChanges: true }).at(-1)?.consequence).toBe(
      'stop execution; close this run; keep changes',
    );
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

  const building = stopSheetRows({
    currentTaskId: 'T002',
    nextTaskId: 'T003',
    boundaryPauseRequested: false,
    hasChanges: true,
  });

  it('states every consequence, so the sheet is as tall as its rows whichever is selected', () => {
    expect(stopMenuLayout(building, 120).bodyRows).toBe(3);
    expect(stopMenuLayout(building, 80).bodyRows).toBe(4);
    expect(stopMenuLayout(building, 60).bodyRows).toBe(5);
  });

  it('breaks a wrapped row between clauses and hangs the rest under its label', () => {
    expect(stopMenuLayout(building, 80).options[1]?.lines).toEqual([
      'Pause after this brief · finish T002 including checks and review;',
      '  do not start T003',
    ]);
    expect(stopMenuLayout(building, 60).options[2]?.lines).toEqual([
      'End run · stop execution; close this run;',
      '  keep changes',
    ]);
  });
});
