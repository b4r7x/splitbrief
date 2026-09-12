import { CELL_HEIGHT, CELL_WIDTH, type Palette, type Seat } from './seats';

export const GLYPHS = ' .:-=o0O@';

export type Tint = 'blue' | 'blue-dim' | 'green' | 'green-dim' | 'spark';

export type Atlas = {
  readonly image: OffscreenCanvas;
  readonly tileWidth: number;
  readonly tileHeight: number;
  row(tint: Tint): number;
};

const BASELINE = 9.5;
const DIM = 0.2;
const SPARK = { share: 0.05, floor: 0.6 };
const BLUE_SHARE = 0.65;
const TOKEN: Readonly<Record<Tint, string>> = {
  blue: '--blue',
  'blue-dim': '--blue-dim',
  green: '--green',
  'green-dim': '--green-dim',
  spark: '--white-spark',
};
const LAB: Readonly<Record<'blue' | 'green', { dim: Tint; accent: Tint }>> = {
  blue: { dim: 'blue-dim', accent: 'blue' },
  green: { dim: 'green-dim', accent: 'green' },
};

function tintsOf(palette: Palette): readonly Tint[] {
  if (palette === 'mixed') return ['blue-dim', 'blue', 'green-dim', 'green', 'spark'];
  return [LAB[palette].dim, LAB[palette].accent, 'spark'];
}

export function glyphIndex(d: number): number {
  return Math.min(GLYPHS.length - 1, Math.max(0, Math.floor(d * (GLYPHS.length - 1))));
}

export function glyphFor(d: number): string {
  return GLYPHS.charAt(glyphIndex(d));
}

function alphaFor(d: number): number {
  if (d < DIM) return 0.55;
  if (d > 0.7) return 1;
  return 0.65 + d * 0.5;
}

export function tintFor(seat: Seat, d: number, sparkHash: number): Tint {
  if (d >= 1 || (d >= SPARK.floor && sparkHash < SPARK.share)) return 'spark';
  const lab =
    seat.palette === 'mixed' ? (sparkHash < BLUE_SHARE ? LAB.blue : LAB.green) : LAB[seat.palette];
  return d < DIM ? lab.dim : lab.accent;
}

export function buildAtlas(seat: Seat, dpr: number): Atlas {
  const tints = tintsOf(seat.palette);
  const tileWidth = CELL_WIDTH * dpr;
  const tileHeight = CELL_HEIGHT * dpr;
  const image = new OffscreenCanvas(tileWidth * GLYPHS.length, tileHeight * tints.length);
  const ctx = image.getContext('2d');
  if (!ctx) throw new Error('atlas canvas has no 2d context');
  const style = getComputedStyle(document.documentElement);
  ctx.font = `${CELL_HEIGHT * dpr}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  tints.forEach((tint, row) => {
    ctx.fillStyle = style.getPropertyValue(TOKEN[tint]).trim();
    for (let index = 1; index < GLYPHS.length; index++) {
      ctx.globalAlpha = alphaFor(index / (GLYPHS.length - 1));
      ctx.fillText(
        GLYPHS.charAt(index),
        (index + 0.5) * tileWidth,
        row * tileHeight + BASELINE * dpr,
      );
    }
  });
  return { image, tileWidth, tileHeight, row: (tint) => tints.indexOf(tint) };
}
