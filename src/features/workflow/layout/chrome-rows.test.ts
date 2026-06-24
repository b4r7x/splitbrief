import { describe, expect, it } from 'vitest';
import {
  BOTTOM_FIXED_CHROME_ROWS,
  BOTTOM_FOOTER_DIVIDER_ROWS,
  CONFIG_CHROME_ROWS,
  INLINE_CONFIG_MIN_COLS,
  TOP_FIXED_CHROME_ROWS,
  getChromeContentWidth,
  getChromeHeight,
  getConfigChromeRows,
  getContentTopRow,
} from './chrome-rows.js';

describe('getChromeContentWidth', () => {
  it('subtracts horizontal chrome padding and clamps to one column', () => {
    expect(getChromeContentWidth(120)).toBe(118);
    expect(getChromeContentWidth(1)).toBe(1);
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

  it('inlines config rows on wide terminals', () => {
    const inputRows = 2;
    expect(getConfigChromeRows(true, INLINE_CONFIG_MIN_COLS)).toBe(0);
    expect(getChromeHeight(inputRows, true, INLINE_CONFIG_MIN_COLS)).toBe(
      getChromeHeight(inputRows, false, INLINE_CONFIG_MIN_COLS),
    );
  });

  it('each additional input row increases chrome height by exactly 1', () => {
    const base = getChromeHeight(1, false);
    expect(getChromeHeight(4, false) - base).toBe(3);
  });
});

describe('bottom footer chrome', () => {
  it('reserves divider, feedback, and composer rows before variable input footer rows', () => {
    expect(BOTTOM_FOOTER_DIVIDER_ROWS).toBe(1);
    expect(BOTTOM_FIXED_CHROME_ROWS).toBe(3);
    expect(BOTTOM_FIXED_CHROME_ROWS).toBe(2 + BOTTOM_FOOTER_DIVIDER_ROWS);

    const inputRows = 2;
    expect(getChromeHeight(inputRows, false)).toBe(
      TOP_FIXED_CHROME_ROWS + BOTTOM_FIXED_CHROME_ROWS + inputRows,
    );
  });
});

describe('getContentTopRow', () => {
  it('starts after the top chrome rows when there is no config', () => {
    expect(getContentTopRow(false)).toBe(TOP_FIXED_CHROME_ROWS + 1);
  });

  it('starts after the top chrome + config rows when config is shown', () => {
    expect(getContentTopRow(true)).toBe(TOP_FIXED_CHROME_ROWS + CONFIG_CHROME_ROWS + 1);
  });

  it('does not add a separate config top row when config is inlined', () => {
    expect(getContentTopRow(true, INLINE_CONFIG_MIN_COLS)).toBe(TOP_FIXED_CHROME_ROWS + 1);
  });
});
