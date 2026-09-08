import { hash } from '../../lib/noise';
import { CELL_HEIGHT, CELL_WIDTH, type Seat } from './seats';
import { inside } from './silhouette';

export type Rect = {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
};

export type GhostBox = { readonly seat: Seat; readonly left: number; readonly top: number };

export type Tier = 'wide' | 'compact';

export type Field = {
  readonly ghosts: readonly GhostBox[];
  readonly exclusions: readonly Rect[];
  readonly tier: Tier;
};

export type ScatterPoint = { readonly x: number; readonly y: number; readonly glyph: string };

type Trail = {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly count: number;
  readonly layer: number;
};

const SEED = 11;
const GLYPHS = '.:·';
const TRAIL_GLYPHS = '.:';
const BAND = { x0: 0, y0: 51.6, x1: 182.4, y1: 223.6, spread: 24, count: 60, layer: 0 };
const HALO = { reach: 30, step: 5, count: 13 };
const TRAILS: Readonly<Record<Tier, readonly Trail[]>> = {
  wide: [
    { x0: 0, y0: 516, x1: 296.4, y1: 860, count: 30, layer: -1 },
    { x0: 418, y0: 731, x1: 760, y1: 860, count: 12, layer: -2 },
  ],
  compact: [{ x0: 210, y0: 274, x1: 350, y1: 470, count: 12, layer: -1 }],
};

export function ghostRect(box: GhostBox): Rect {
  return {
    left: box.left,
    top: box.top,
    width: box.seat.cols * CELL_WIDTH,
    height: box.seat.rows * CELL_HEIGHT,
  };
}

function inGhost(box: GhostBox, x: number, y: number): boolean {
  const rect = ghostRect(box);
  return inside((x - rect.left) / rect.width, (y - rect.top) / rect.height);
}

function inRect(rect: Rect, x: number, y: number): boolean {
  return (
    x > rect.left - CELL_WIDTH &&
    x < rect.left + rect.width &&
    y > rect.top - CELL_HEIGHT &&
    y < rect.top + rect.height
  );
}

function nearRim(box: GhostBox, x: number, y: number): boolean {
  if (inGhost(box, x, y)) return false;
  const rect = ghostRect(box);
  const dx = rect.left + rect.width / 2 - x;
  const dy = rect.top + rect.height / 2 - y;
  const length = Math.hypot(dx, dy);
  for (let s = HALO.step; s <= HALO.reach; s += HALO.step) {
    if (inGhost(box, x + (dx / length) * s, y + (dy / length) * s)) return true;
  }
  return false;
}

function clear(field: Field, x: number, y: number): boolean {
  return (
    field.ghosts.every((box) => !inGhost(box, x, y)) &&
    field.exclusions.every((rect) => !inRect(rect, x, y))
  );
}

function glyphAt(k: number, layer: number, glyphs: string): string {
  return glyphs.charAt(Math.floor(hash(SEED, k, 2, layer) * glyphs.length));
}

function band(field: Field): ScatterPoint[] {
  const dx = BAND.x1 - BAND.x0;
  const dy = BAND.y1 - BAND.y0;
  const length = Math.hypot(dx, dy);
  const points: ScatterPoint[] = [];
  for (let k = 0; points.length < BAND.count && k < BAND.count * 3; k++) {
    const along = hash(SEED, k, 0, BAND.layer);
    const across = (hash(SEED, k, 1, BAND.layer) * 2 - 1) * BAND.spread;
    const x = BAND.x0 + along * dx - (dy / length) * across;
    const y = BAND.y0 + along * dy + (dx / length) * across;
    if (clear(field, x, y)) points.push({ x, y, glyph: glyphAt(k, BAND.layer, GLYPHS) });
  }
  return points;
}

function trail(field: Field, region: Trail): ScatterPoint[] {
  const points: ScatterPoint[] = [];
  for (let k = 0; points.length < region.count && k < region.count * 3; k++) {
    const x = region.x0 + hash(SEED, k, 0, region.layer) * (region.x1 - region.x0);
    const y = region.y0 + hash(SEED, k, 1, region.layer) * (region.y1 - region.y0);
    if (clear(field, x, y)) points.push({ x, y, glyph: glyphAt(k, region.layer, TRAIL_GLYPHS) });
  }
  return points;
}

function halo(field: Field, box: GhostBox, layer: number): ScatterPoint[] {
  const rect = ghostRect(box);
  const points: ScatterPoint[] = [];
  for (let k = 0; points.length < HALO.count && k < HALO.count * 40; k++) {
    const x = rect.left - HALO.reach + hash(SEED, k, 0, layer) * (rect.width + 2 * HALO.reach);
    const y = rect.top - HALO.reach + hash(SEED, k, 1, layer) * (rect.height + 2 * HALO.reach);
    if (nearRim(box, x, y) && clear(field, x, y)) {
      points.push({ x, y, glyph: glyphAt(k, layer, GLYPHS) });
    }
  }
  return points;
}

export function scatterPoints(field: Field): ScatterPoint[] {
  return [
    ...(field.tier === 'wide' ? band(field) : []),
    ...TRAILS[field.tier].flatMap((region) => trail(field, region)),
    ...field.ghosts.flatMap((box, i) => halo(field, box, i + 1)),
  ];
}

export function scatterFragment(points: readonly ScatterPoint[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const point of points) {
    const glyph = document.createElement('span');
    glyph.textContent = point.glyph;
    glyph.style.translate = `${point.x}px ${point.y}px`;
    fragment.append(glyph);
  }
  return fragment;
}
