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

export function overlayInnerRowCapacity(input: { rows: number; outerChromeRows: number }): number {
  return Math.max(0, input.rows - OVERLAY_FRAME_ROWS - input.outerChromeRows);
}

export interface OverlayRect {
  width: number;
  innerWidth: number;
  height: number;
  innerRows: number;
}

export function overlayRect(input: {
  cols: number;
  rows: number;
  density: OverlayDensity;
}): OverlayRect {
  const width = overlayWidth(input);
  return {
    width,
    innerWidth: width - OVERLAY_FRAME_COLS,
    height: input.rows,
    innerRows: overlayInnerRowCapacity({ rows: input.rows, outerChromeRows: 0 }),
  };
}
