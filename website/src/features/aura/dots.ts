import { hash } from '../../lib/noise';
import type { Rect } from '../fragments/place';

export type Profile = 'edge' | 'skyline' | 'ground' | 'column';
export type Field = {
  readonly seed: number;
  readonly profile: Profile;
  readonly flip: boolean;
  readonly rim: boolean;
  readonly level: number;
};
export type FieldSpec = Field & {
  readonly left: number;
  readonly top: number;
  readonly cols: number;
  readonly rows: number;
};
export type Cell = {
  readonly c: number;
  readonly r: number;
  readonly glyph: '.' | ':';
  readonly alpha: number;
  readonly bright: boolean;
};
export const CELL = { width: 7, height: 11 };
const RELIT = 0.02;
const BLOCK = 24;
const FADE_FROM = 0.85;
const DENSE = 0.4;
const BRIGHT = 0.12;
// Between its streaks the rim's outer column carries a grain, sparse beside the hero and full
// below it, so no 40 px band beside a section seam is empty.
const RIM = { cols: 2, from: 0.2, to: 0.8, dust: 0.3 };

function n(u: number, seed: number): number {
  return 0.5 + 0.5 * Math.sin(9.4 * u + seed) * Math.cos(4.1 * u - 0.7 * seed);
}

type Streak = {
  readonly on: number;
  readonly reach: number;
  readonly dense: number;
  readonly dust: number;
};

function ramp(v: number, from: number, to: number): number {
  const t = Math.min(1, Math.max(0, (v - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

function edgeStreak(spec: FieldSpec, c: number, v: number): Streak {
  const across = (c + 0.5) / spec.cols;
  const u = spec.flip ? 1 - across : across;
  const outer = spec.flip ? spec.cols - 1 - c : c;
  if (spec.rim && outer < RIM.cols) {
    const weight = outer === 0 ? 1 : 0.5;
    const grain = ramp(v, RIM.from, RIM.to);
    return {
      on: (0.3 + 0.65 * grain) * weight,
      reach: 14,
      dense: 0.7,
      dust: RIM.dust * (0.35 + 0.65 * grain) * weight,
    };
  }
  const on = 0.3 * (1 - 0.6 * u);
  return { on, reach: 3, dense: 0.55, dust: 0.03 * on };
}

function edgeFade(v: number): number {
  return 1 - 0.7 * ramp(v, FADE_FROM, 1);
}

function streak(spec: FieldSpec, c: number, r: number, { on, reach, dense, dust }: Streak): number {
  const block = Math.floor(r / BLOCK);
  const lit = hash(spec.seed, c, block, 7) < on;
  const centre = block * BLOCK + hash(spec.seed, c, block, 8) * BLOCK;
  const half = 1 + reach * hash(spec.seed, c, block, 9);
  return lit && Math.abs(r + 0.5 - centre) <= half ? dense : dust;
}

export function share(spec: FieldSpec, c: number, r: number): number {
  const across = (c + 0.5) / spec.cols;
  const u = spec.flip ? 1 - across : across;
  const v = (r + 0.5) / spec.rows;
  const { profile, seed, level } = spec;
  if (profile === 'edge') return level * edgeFade(v) * streak(spec, c, r, edgeStreak(spec, c, v));
  if (profile === 'skyline') {
    const tall = 0.7 * hash(seed, c, 0, 6) ** 1.5 * (hash(seed, c, 1, 6) < 0.4 ? 1 : 0.15);
    return level * (v >= 1 - tall ? 0.55 : 0.02 * v);
  }
  if (profile === 'ground') {
    return level * 0.55 * (0.1 + 0.9 * n(u, seed) ** 2) * (0.4 + 0.6 * v);
  }
  return (
    level * 0.22 * (0.3 + 0.7 * (1 - Math.abs(u - 0.5) * 2)) * (0.6 + 0.4 * Math.sin(7 * v + seed))
  );
}

// The lit share a row is expected to carry before any cell is drawn: the edge model averaged over
// its streak draws (a streak covers 3 + reach rows of a block on average), the others as drawn.
// The oracle dots.test.ts holds the drawn field against; nothing in production reads it.
export function density(spec: FieldSpec, r: number): number {
  const v = (r + 0.5) / spec.rows;
  let sum = 0;
  for (let c = 0; c < spec.cols; c++) {
    if (spec.profile !== 'edge') {
      sum += share(spec, c, r);
      continue;
    }
    const { on, reach, dense, dust } = edgeStreak(spec, c, v);
    const covered = (on * (3 + reach)) / BLOCK;
    sum += spec.level * edgeFade(v) * (covered * dense + (1 - covered) * dust);
  }
  return sum / spec.cols;
}

function cell(spec: FieldSpec, c: number, r: number, tick: number): Cell {
  const stacked = share(spec, c, r) > DENSE ? 0.5 : 0.2;
  return {
    c,
    r,
    alpha: 0.3 + 0.4 * hash(spec.seed, c, r, 4 * tick + 1),
    glyph: hash(spec.seed, c, r, 4 * tick + 2) < stacked ? ':' : '.',
    bright: hash(spec.seed, c, r, 5) < BRIGHT,
  };
}

export function cells(spec: FieldSpec): Cell[] {
  const out: Cell[] = [];
  for (let c = 0; c < spec.cols; c++) {
    for (let r = 0; r < spec.rows; r++) {
      if (hash(spec.seed, c, r, 0) < share(spec, c, r)) out.push(cell(spec, c, r, 0));
    }
  }
  return out;
}

export type Relit = { readonly at: number; readonly alpha: number };

export function relit(spec: FieldSpec, lit: readonly Cell[], tick: number): Relit[] {
  return lit.flatMap(({ c, r }, at) =>
    hash(spec.seed, c, r, 4 * tick + 3) < RELIT
      ? [{ at, alpha: 0.3 + 0.4 * hash(spec.seed, c, r, 4 * tick + 1) }]
      : [],
  );
}

export function cellRect(spec: FieldSpec, { c, r }: Cell): Rect {
  const left = spec.left + c * CELL.width;
  const top = spec.top + r * CELL.height;
  return { left, top, right: left + CELL.width, bottom: top + CELL.height };
}

export function latticeField(
  field: Field,
  rect: Rect,
  origin: { readonly x: number; readonly y: number },
): FieldSpec | undefined {
  const left = origin.x + Math.ceil((rect.left - origin.x) / CELL.width) * CELL.width;
  const top = origin.y + Math.ceil((rect.top - origin.y) / CELL.height) * CELL.height;
  const cols = Math.floor((rect.right - left) / CELL.width);
  const rows = Math.floor((rect.bottom - top) / CELL.height);
  return cols < 1 || rows < 1 ? undefined : { ...field, left, top, cols, rows };
}
