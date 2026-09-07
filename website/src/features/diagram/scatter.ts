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

export type Field = { readonly ghosts: readonly GhostBox[]; readonly exclusions: readonly Rect[] };

export type ScatterPoint = { readonly x: number; readonly y: number; readonly glyph: string };

const SEED = 11;
const GLYPHS = '.:·';
const BAND = { x0: 0, y0: 51.6, x1: 182.4, y1: 223.6, spread: 24, count: 60 };
const TRAIL = { x0: 0, y0: 516, x1: 296.4, y1: 860, count: 30, glyphs: '.:' };
const HALO = { reach: 30, step: 5, count: 13 };
const BAND_LAYER = 0;
const TRAIL_LAYER = -1;

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
    const along = hash(SEED, k, 0, BAND_LAYER);
    const across = (hash(SEED, k, 1, BAND_LAYER) * 2 - 1) * BAND.spread;
    const x = BAND.x0 + along * dx - (dy / length) * across;
    const y = BAND.y0 + along * dy + (dx / length) * across;
    if (clear(field, x, y)) points.push({ x, y, glyph: glyphAt(k, BAND_LAYER, GLYPHS) });
  }
  return points;
}

function trail(field: Field): ScatterPoint[] {
  const points: ScatterPoint[] = [];
  for (let k = 0; points.length < TRAIL.count && k < TRAIL.count * 3; k++) {
    const x = TRAIL.x0 + hash(SEED, k, 0, TRAIL_LAYER) * (TRAIL.x1 - TRAIL.x0);
    const y = TRAIL.y0 + hash(SEED, k, 1, TRAIL_LAYER) * (TRAIL.y1 - TRAIL.y0);
    if (clear(field, x, y)) points.push({ x, y, glyph: glyphAt(k, TRAIL_LAYER, TRAIL.glyphs) });
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
    ...band(field),
    ...trail(field),
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
