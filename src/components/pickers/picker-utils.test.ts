import { describe, expect, it } from 'vitest';
import { computeScrollWindow } from './picker-utils.js';

const items = Array.from({ length: 30 }, (_, index) => index);

describe('computeScrollWindow', () => {
  it('caps the visible rows at maxVisible on a tall terminal', () => {
    const window = computeScrollWindow({
      items,
      selectedIndex: 0,
      terminalRows: 40,
      chromeRows: 2,
      maxVisible: 5,
    });
    expect(window.maxVisible).toBe(5);
    expect(window.visibleSlice).toHaveLength(5);
  });

  it('fills available rows when maxVisible is omitted', () => {
    const window = computeScrollWindow({
      items,
      selectedIndex: 0,
      terminalRows: 40,
      chromeRows: 2,
    });
    expect(window.maxVisible).toBe(38);
  });

  it('never grows beyond the available rows even when maxVisible is larger', () => {
    const window = computeScrollWindow({
      items,
      selectedIndex: 0,
      terminalRows: 12,
      chromeRows: 2,
      maxVisible: 50,
    });
    expect(window.maxVisible).toBe(10);
  });
});
