import { describe, it, expect } from 'vitest';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { stopSheetRows } from '../stop/options.js';
import { inlineMenuChrome, inlineMenuLayout } from './layout.js';

describe('inlineMenuChrome', () => {
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
      expect(inlineMenuChrome(box, body)).toEqual({ framed, titled, legend, listRows, extraRows });
    },
  );
});

describe('inlineMenuLayout', () => {
  it('takes the composer width at every terminal width, so the two stacked boxes share both edges', () => {
    const rows = stopSheetRows({
      currentTaskId: 'T002',
      nextTaskId: 'T003',
      boundaryPauseRequested: false,
    });

    for (const cols of [60, 120, 220]) {
      expect(inlineMenuLayout(rows, cols).width).toBe(getChromeContentWidth(cols));
    }
  });

  const building = stopSheetRows({
    currentTaskId: 'T002',
    nextTaskId: 'T003',
    boundaryPauseRequested: false,
    hasChanges: true,
  });

  it('states every consequence, so the sheet is as tall as its rows whichever is selected', () => {
    expect(inlineMenuLayout(building, 120).bodyRows).toBe(3);
    expect(inlineMenuLayout(building, 80).bodyRows).toBe(4);
    expect(inlineMenuLayout(building, 60).bodyRows).toBe(6);
  });

  it('aligns wrapped consequences with their description column', () => {
    const { lines } = inlineMenuLayout(building, 80);
    const pause = lines.filter((line) => line.row === 1);
    const text = pause.map((line) => line.name + line.description);
    expect(text.length).toBeGreaterThan(1);
    expect(text.map((line) => line.trim()).join(' ')).toContain('do not start T003');
    expect(text[0]?.indexOf('finish')).toBe(text[1]?.search(/\S/u));
  });
});
