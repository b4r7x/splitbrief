import { describe, it, expect } from 'vitest';
import {
  BOTTOM_FIXED_CHROME_ROWS,
  CONFIG_CHROME_ROWS,
  getChromeHeight,
  getContentTopRow,
  TOP_FIXED_CHROME_ROWS,
} from './chrome-rows.js';

describe('getChromeHeight', () => {
  it('returns base chrome without config event', () => {
    expect(getChromeHeight(3, false)).toBe(TOP_FIXED_CHROME_ROWS + BOTTOM_FIXED_CHROME_ROWS + 3);
  });

  it('adds config rows when config event is present', () => {
    expect(getChromeHeight(3, true)).toBe(TOP_FIXED_CHROME_ROWS + CONFIG_CHROME_ROWS + BOTTOM_FIXED_CHROME_ROWS + 3);
  });

  it('reflects different inputRows correctly', () => {
    expect(getChromeHeight(1, false)).toBe(TOP_FIXED_CHROME_ROWS + BOTTOM_FIXED_CHROME_ROWS + 1);
    expect(getChromeHeight(5, true)).toBe(TOP_FIXED_CHROME_ROWS + CONFIG_CHROME_ROWS + BOTTOM_FIXED_CHROME_ROWS + 5);
  });

  it('is strictly greater with config than without', () => {
    const withConfig = getChromeHeight(3, true);
    const withoutConfig = getChromeHeight(3, false);
    expect(withConfig).toBeGreaterThan(withoutConfig);
    expect(withConfig - withoutConfig).toBe(CONFIG_CHROME_ROWS);
  });

  it('exposes the first content row directly', () => {
    expect(getContentTopRow(false)).toBe(TOP_FIXED_CHROME_ROWS + 1);
    expect(getContentTopRow(true)).toBe(TOP_FIXED_CHROME_ROWS + CONFIG_CHROME_ROWS + 1);
  });
});
