import { describe, it, expect } from 'vitest';
import { getClampedTerminalWidth, getResponsivePanelWidth } from './terminal-width.js';

describe('terminal-width helpers', () => {
  it('clamps computed panel widths to a positive value on narrow terminals', () => {
    expect(getClampedTerminalWidth(3, 80)).toBe(1);
    expect(getResponsivePanelWidth(3, true)).toBe(1);
    expect(getResponsivePanelWidth(90, true)).toBe(76);
  });
});
