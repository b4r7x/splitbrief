import { describe, expect, it } from 'vitest';
import {
  OVERLAY_DENSITIES,
  type OverlayDensity,
  overlayGutterRows,
  overlayRect,
  overlayWidth,
} from './overlay-rect.js';

const COLUMN_CASES = [60, 80, 100, 120, 140, 200];

const EXPECTED_WIDTHS: Record<OverlayDensity, number[]> = {
  compact: [56, 56, 60, 72, 72, 72],
  roomy: [56, 76, 76, 84, 96, 96],
  wide: [56, 76, 90, 108, 126, 140],
};

describe('overlayWidth', () => {
  for (const density of OVERLAY_DENSITIES) {
    it(`grows ${density} panels with the terminal between its floor and its ceiling`, () => {
      expect(COLUMN_CASES.map((cols) => overlayWidth({ cols, density }))).toEqual(
        EXPECTED_WIDTHS[density],
      );
    });
  }

  it('never exceeds the terminal minus its margins', () => {
    for (const density of OVERLAY_DENSITIES) {
      for (const cols of COLUMN_CASES) {
        expect(overlayWidth({ cols, density })).toBeLessThanOrEqual(cols - 4);
      }
    }
  });
});

describe('overlayGutterRows', () => {
  it('adds breathing room as the terminal gets taller, capped at two rows', () => {
    expect([18, 24, 30, 40].map(overlayGutterRows)).toEqual([0, 1, 2, 2]);
  });
});

describe('overlayRect', () => {
  it('reports the frame budget for a roomy panel on a tall terminal', () => {
    expect(overlayRect({ cols: 120, rows: 40, density: 'roomy' })).toEqual({
      width: 84,
      innerWidth: 78,
      maxOuterRows: 38,
      innerRows: 34,
    });
  });

  it('reports the frame budget for a wide panel on a short terminal', () => {
    expect(overlayRect({ cols: 60, rows: 18, density: 'wide' })).toEqual({
      width: 56,
      innerWidth: 50,
      maxOuterRows: 18,
      innerRows: 14,
    });
  });
});
