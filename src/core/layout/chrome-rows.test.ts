import { describe, expect, it } from 'vitest';
import {
  BOTTOM_FIXED_CHROME_ROWS,
  CONFIG_CHROME_ROWS,
  TOP_FIXED_CHROME_ROWS,
  getChromeHeight,
  getContentTopRow,
} from './chrome-rows.js';

describe('chrome row constants', () => {
  it('TOP_FIXED_CHROME_ROWS is 4, accounting for Header, AgentStatusRow, CostStatusLine, and spacer', () => {
    // The cost status line is row 3 of the top chrome. Any change to this value
    // must be reflected in the layout and accompanied by a test update.
    expect(TOP_FIXED_CHROME_ROWS).toBe(4);
  });

  it('CONFIG_CHROME_ROWS is 2', () => {
    expect(CONFIG_CHROME_ROWS).toBe(2);
  });

  it('BOTTOM_FIXED_CHROME_ROWS is 2', () => {
    expect(BOTTOM_FIXED_CHROME_ROWS).toBe(2);
  });
});

describe('getChromeHeight', () => {
  it('sums top + bottom + inputRows when config is hidden', () => {
    const inputRows = 2;
    expect(getChromeHeight(inputRows, false)).toBe(
      TOP_FIXED_CHROME_ROWS + BOTTOM_FIXED_CHROME_ROWS + inputRows,
    );
  });

  it('includes config rows when config is shown', () => {
    const inputRows = 2;
    expect(getChromeHeight(inputRows, true)).toBe(
      TOP_FIXED_CHROME_ROWS + CONFIG_CHROME_ROWS + BOTTOM_FIXED_CHROME_ROWS + inputRows,
    );
    expect(getChromeHeight(inputRows, true)).toBeGreaterThan(getChromeHeight(inputRows, false));
  });

  it('each additional input row increases chrome height by exactly 1', () => {
    const base = getChromeHeight(1, false);
    expect(getChromeHeight(4, false) - base).toBe(3);
  });
});

describe('getContentTopRow', () => {
  it('starts after the top chrome rows when there is no config', () => {
    expect(getContentTopRow(false)).toBe(TOP_FIXED_CHROME_ROWS + 1);
  });

  it('starts after the top chrome + config rows when config is shown', () => {
    expect(getContentTopRow(true)).toBe(TOP_FIXED_CHROME_ROWS + CONFIG_CHROME_ROWS + 1);
  });
});
