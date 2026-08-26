export const OVERLAY_DENSITIES = ['compact', 'roomy', 'wide'] as const;
export type OverlayDensity = (typeof OVERLAY_DENSITIES)[number];

interface DensityRule {
  share: number;
  min: number;
  max: number;
}

const DENSITY_RULES: Readonly<Record<OverlayDensity, DensityRule>> = {
  compact: { share: 0.6, min: 56, max: 72 },
  roomy: { share: 0.7, min: 76, max: 96 },
  wide: { share: 0.9, min: 76, max: 140 },
};

export const OVERLAY_FRAME_COLS = 6;
export const OVERLAY_FRAME_ROWS = 4;

export function overlayWidth(input: { cols: number; density: OverlayDensity }): number {
  const rule = DENSITY_RULES[input.density];
  return Math.min(
    input.cols - 4,
    Math.max(rule.min, Math.floor(input.cols * rule.share)),
    rule.max,
  );
}

export function overlayGutterRows(rows: number): number {
  return Math.min(2, Math.floor(Math.max(0, rows - 18) / 6));
}

export interface OverlayRect {
  width: number;
  innerWidth: number;
  maxOuterRows: number;
  innerRows: number;
}

export function overlayRect(input: {
  cols: number;
  rows: number;
  density: OverlayDensity;
}): OverlayRect {
  const width = overlayWidth(input);
  const maxOuterRows = input.rows - overlayGutterRows(input.rows);
  return {
    width,
    innerWidth: width - OVERLAY_FRAME_COLS,
    maxOuterRows,
    innerRows: maxOuterRows - OVERLAY_FRAME_ROWS,
  };
}
