import { describe, expect, it } from 'vitest';
import {
  BACK_HINT,
  CANCEL_HINT,
  CLOSE_HINT,
  CONFIRM_HINT,
  fitKeyLegend,
  formatKeyHints,
  KEY_LEGEND_LEADING,
  SCROLL_HINT,
  SELECT_HINT,
} from './key-legend.js';
import { getTerminalCellWidth } from '../utils/display-text/width.js';

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

  it('measures terminal cells, not string length', () => {
    expect(fitKeyLegend('界界 · ab', 8)).toBe('界界');
  });

  it('shows nothing rather than a fragment when not even one token fits', () => {
    expect(fitKeyLegend('y approve · c comment', 4)).toBe('');
  });
});

describe('formatKeyHints', () => {
  it('joins each key and its verb with the soft separator', () => {
    expect(formatKeyHints([SELECT_HINT, CONFIRM_HINT, CLOSE_HINT])).toBe(
      '↑↓ select · ⏎ confirm · esc close',
    );
  });

  it('spells the shared escape and scroll keys in the legend grammar', () => {
    expect(formatKeyHints([SCROLL_HINT, BACK_HINT])).toBe('↑↓ scroll · esc back');
    expect(formatKeyHints([CANCEL_HINT])).toBe('esc cancel');
  });
});
