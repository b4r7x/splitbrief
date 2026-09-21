import { describe, expect, it } from 'vitest';
import { getScrollViewportContentWidth } from './scrollbar.js';

describe('getScrollViewportContentWidth', () => {
  it('reserves two cells for the separator and the bar', () => {
    expect(getScrollViewportContentWidth(80)).toBe(78);
    expect(getScrollViewportContentWidth(60)).toBe(58);
  });

  it('floors at zero for widths at or below the gutter', () => {
    expect(getScrollViewportContentWidth(2)).toBe(0);
    expect(getScrollViewportContentWidth(1)).toBe(0);
  });

  it('floors at zero for negative widths', () => {
    expect(getScrollViewportContentWidth(-5)).toBe(0);
  });

  it('floors the input before subtracting the gutter', () => {
    expect(getScrollViewportContentWidth(10.7)).toBe(8);
  });
});
