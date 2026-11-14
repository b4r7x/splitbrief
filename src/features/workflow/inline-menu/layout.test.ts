import { describe, it, expect } from 'vitest';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { stopSheetRows } from '../stop/options.js';
import { stopMenuChrome, stopMenuLayout } from './layout.js';

describe('stopMenuChrome', () => {
  it.each([
    [0, 3, false, false, false, 0, 0],
    [2, 3, false, false, false, 2, 0],
    [3, 3, false, false, false, 3, 0],
    [4, 3, false, true, false, 3, 0],
    [5, 3, false, true, false, 3, 0],
    [6, 3, true, true, false, 3, 0],
    [7, 3, true, true, true, 3, 0],
    [8, 3, true, true, true, 3, 1],
  ])(
    'fits a box of %i rows around %i rows',
    (box, body, framed, titled, legend, listRows, extraRows) => {
      expect(stopMenuChrome(box, body)).toEqual({ framed, titled, legend, listRows, extraRows });
    },
  );
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
