import { describe, expect, it } from 'vitest';
import { fitKeyLegend, KEY_LEGEND_LEADING } from './key-legend.js';
import { getTerminalCellWidth } from '../utils/display-text.js';

describe('KEY_LEGEND_LEADING', () => {
  it('measures exactly the two-cell mark slot, whatever mark it carries', () => {
    expect(getTerminalCellWidth(KEY_LEGEND_LEADING)).toBe(2);
  });
});

describe('fitKeyLegend', () => {
  it('drops whole trailing tokens rather than ellipsising a key in half', () => {
    const legend = 'y approve · c comment · q reject · e edit';

    expect(fitKeyLegend(legend, legend.length)).toBe(legend);
    expect(fitKeyLegend(legend, 40)).toBe('y approve · c comment · q reject');
    expect(fitKeyLegend(legend, 20)).toBe('y approve');
    expect(fitKeyLegend(legend, 40)).not.toContain('…');
  });

  it('shows nothing rather than a fragment when not even one token fits', () => {
    expect(fitKeyLegend('y approve · c comment', 4)).toBe('');
  });
});
