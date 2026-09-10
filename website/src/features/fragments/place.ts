import { hash } from '../../lib/noise';

export type Rect = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

export type Viewport = { readonly width: number; readonly height: number };

export type KeepClear = {
  readonly text: readonly Rect[];
  readonly marks: readonly Rect[];
  readonly panels: readonly Rect[];
};

export type Placement = {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly duration: number;
  readonly opacity: number;
  readonly phase: number;
};

export type Layer = {
  readonly pool: readonly string[];
  readonly seed: number;
  readonly opacity: { readonly min: number; readonly max: number };
  readonly lineGap: number;
  readonly gutterGlyphs: readonly string[];
  readonly glyphHeight: number;
  readonly textGap: { readonly x: number; readonly y: number };
};

const TRIES = 2000;
const TRAVEL = 64;
const MARGIN = 6;
const STRIPES = 4;
const SPREAD = 62;
const GLYPH = { width: 6.6, height: 11 };
const DURATION = { min: 14, max: 28 };
const LINE_PAD = 8;
const GUTTER_INSET = 24;
const SEAM = 24;

export function travelBand(text: string, x: number, y: number, glyphHeight = GLYPH.height): Rect {
  return {
    left: x - MARGIN,
    top: y - TRAVEL - MARGIN,
    right: x + text.length * GLYPH.width + MARGIN,
    bottom: y + glyphHeight + MARGIN,
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function onLine(
  rect: Rect,
  x: number,
  y: number,
  width: number,
  gap: number,
  glyphHeight: number,
): boolean {
  return (
    rect.top - LINE_PAD < y + glyphHeight + LINE_PAD &&
    rect.bottom + LINE_PAD > y - TRAVEL - LINE_PAD &&
    !(x >= rect.right + gap || x + width <= rect.left - gap)
  );
}

export function isTrace(text: string): boolean {
  return text.startsWith('· ·');
}

export function placeFragments(
  viewport: Viewport,
  keepClear: KeepClear,
  layer: Layer,
): Placement[] {
  const placed: Placement[] = [];
  const taken: Rect[] = [
    ...keepClear.marks,
    ...keepClear.text.map((rect) => ({
      left: rect.left - layer.textGap.x,
      top: rect.top - layer.textGap.y,
      right: rect.right + layer.textGap.x,
      bottom: rect.bottom + layer.textGap.y,
    })),
  ];
  const span = viewport.height - TRAVEL - layer.glyphHeight;
  let k = 0;
  const ordered = layer.pool
    .map((text, i) => ({ text, i }))
    .sort((a, b) => Number(isTrace(b.text)) - Number(isTrace(a.text)));
  for (const { text, i } of ordered) {
    for (let tries = 0; tries < TRIES; tries++, k++) {
      const width = text.length * GLYPH.width;
      const x = MARGIN + hash(layer.seed, k, 0, 0) * (viewport.width - width - 2 * MARGIN);
      const y =
        tries < TRIES / 2
          ? TRAVEL + (((i % STRIPES) + hash(layer.seed, k, 1, 0)) / STRIPES) * span
          : TRAVEL + hash(layer.seed, k, 1, 0) * span;
      const band = travelBand(text, x, y, layer.glyphHeight);
      if (taken.some((rect) => overlaps(rect, band))) continue;
      if (placed.some((other) => Math.hypot(other.x - x, other.y - y) < SPREAD)) continue;
      const gap = isTrace(text) ? 2 * layer.lineGap : layer.lineGap;
      if (
        layer.lineGap > 0 &&
        text.length > 1 &&
        keepClear.text.some(
          (rect) =>
            !keepClear.panels.some((panel) => overlaps(rect, panel)) &&
            onLine(rect, x, y, width, gap, layer.glyphHeight),
        )
      )
        continue;
      taken.push(band);
      placed.push({
        text,
        x,
        y,
        duration: DURATION.min + hash(layer.seed, k, 2, 0) * (DURATION.max - DURATION.min),
        opacity:
          layer.opacity.min + hash(layer.seed, k, 3, 0) * (layer.opacity.max - layer.opacity.min),
        phase: hash(layer.seed, k, 4, 0),
      });
      break;
    }
  }
  if (layer.gutterGlyphs.length > 0) {
    for (let j = 0; j < 4; j++) {
      const side = j % 2;
      const glyph =
        layer.gutterGlyphs[Math.floor(hash(layer.seed, j, 5, 0) * layer.gutterGlyphs.length)];
      if (glyph === undefined) continue;
      const x = side === 0 ? GUTTER_INSET : viewport.width - GUTTER_INSET - GLYPH.width;
      const y =
        SEAM +
        TRAVEL +
        hash(layer.seed, j, 6, 0) * (viewport.height - 2 * SEAM - TRAVEL - layer.glyphHeight);
      const band = travelBand(glyph, x, y, layer.glyphHeight);
      if (taken.some((rect) => overlaps(rect, band))) continue;
      if (placed.some((other) => Math.hypot(other.x - x, other.y - y) < SPREAD)) continue;
      taken.push(band);
      placed.push({
        text: glyph,
        x,
        y,
        duration: DURATION.min + hash(layer.seed, 10_000 + j, 2, 0) * (DURATION.max - DURATION.min),
        opacity:
          layer.opacity.min +
          hash(layer.seed, 10_000 + j, 3, 0) * (layer.opacity.max - layer.opacity.min),
        phase: hash(layer.seed, 10_000 + j, 4, 0),
      });
    }
  }
  return placed;
}
