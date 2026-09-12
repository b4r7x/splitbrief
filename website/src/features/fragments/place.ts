import { hash } from '../../lib/noise';

export type Rect = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

export type KeepClear = {
  readonly text: readonly Rect[];
  readonly marks: readonly Rect[];
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
  readonly textGap: { readonly x: number; readonly y: number };
};

const TRIES = 2000;
const MARGIN = 6;
const STRIPES = 4;
const SPREAD = 62;
// One .backdrop glyph (aura.css: 15px JetBrains Mono, 0.6 em advance, on a 22px line).
const GLYPH = { width: 9, height: 22 };

const DURATION = { min: 14, max: 28 };

function size(text: string): { width: number; height: number } {
  const lines = text.split('\n');
  return {
    width: Math.max(...lines.map((line) => line.length)) * GLYPH.width,
    height: lines.length * GLYPH.height,
  };
}

export function footprint(text: string, x: number, y: number): Rect {
  const { width, height } = size(text);
  return {
    left: x - MARGIN,
    top: y - MARGIN,
    right: x + width + MARGIN,
    bottom: y + height + MARGIN,
  };
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function placeFragments(zone: Rect, keepClear: KeepClear, layer: Layer): Placement[] {
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
  let k = 0;
  for (const [i, text] of layer.pool.entries()) {
    const { width, height } = size(text);
    const span = zone.bottom - zone.top - height;
    if (span <= 0) continue;
    for (let tries = 0; tries < TRIES; tries++, k++) {
      const x =
        zone.left +
        MARGIN +
        hash(layer.seed, k, 0, 0) * (zone.right - zone.left - width - 2 * MARGIN);
      const y =
        zone.top +
        (tries < TRIES / 2
          ? (((i % STRIPES) + hash(layer.seed, k, 1, 0)) / STRIPES) * span
          : hash(layer.seed, k, 1, 0) * span);
      const band = footprint(text, x, y);
      if (taken.some((rect) => overlaps(rect, band))) continue;
      if (placed.some((other) => Math.hypot(other.x - x, other.y - y) < SPREAD)) continue;
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
  return placed;
}
