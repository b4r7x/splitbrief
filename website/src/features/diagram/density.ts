import { hash, valueNoise } from '../../lib/noise';
import type { Cell, Seat } from './seats';
import { CROWN, eye, inside, pupilCell, SKIRT } from './silhouette';

const NOISE_SPAN = 3;
const CORE = { v: 0.55, rx: 0.5, ry: 0.85 };
const BODY_PEAK = 0.875;
const GLITCH_LAYER = -2;
const GRAIN_LAYER = -3;
const HALO_FLOOR = 0.05;
// One breath for all three figures: rest is the bright state, one 8 % exhale per 5 s cycle.
const BREATH = { period: 5, dip: 0.08 };
const REST: Pose = {};

export type Pose = {
  readonly gaze?: Cell;
  readonly lift?: number;
  readonly gain?: number;
  readonly jolt?: boolean;
};

function isSurrounded(seat: Seat, c: number, r: number): boolean {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!inside((c + dc + 0.5) / seat.cols, (r + dr + 0.5) / seat.rows)) return false;
    }
  }
  return true;
}

function isNearRim(seat: Seat, c: number, r: number): boolean {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (inside((c + dc + 0.5) / seat.cols, (r + dr + 0.5) / seat.rows)) return true;
    }
  }
  return false;
}

function isPupil(seat: Seat, c: number, r: number, gaze: Cell): boolean {
  const left = pupilCell(seat, 'left', gaze);
  const right = pupilCell(seat, 'right', gaze);
  return (left.c === c && left.r === r) || (right.c === c && right.r === r);
}

export function density(seat: Seat, c: number, r: number, t: number, pose: Pose = REST): number {
  const { gaze = seat.gaze, lift = 0, gain = 1 } = pose;
  const u = (c + 0.5) / seat.cols;
  const v = (r + 0.5) / seat.rows;
  const tick = Math.floor(t * seat.frequency);
  const n = valueNoise(seat.seed, c / NOISE_SPAN, r / NOISE_SPAN, tick / NOISE_SPAN);
  if (!inside(u, v)) return isNearRim(seat, c, r) ? HALO_FLOOR + 0.1 * n : 0;
  if (eye(u, v)) return isPupil(seat, c, r, gaze) ? 1 : 0;
  const dist = Math.min(1, Math.hypot((u - 0.5) / CORE.rx, (v - CORE.v) / CORE.ry));
  let d = 0.56 + 0.3 * (1 - dist ** 3);
  d += 0.28 * (n - 0.5) + 0.16 * (hash(seat.seed, c, r, GRAIN_LAYER) - 0.5);
  if (v < CROWN) d *= 0.6 + 0.4 * (v / CROWN);
  if (v >= SKIRT) d *= 1 - (0.75 * (v - SKIRT)) / (1 - SKIRT);
  if (!isSurrounded(seat, c, r)) d *= 0.55 + 0.35 * lift;
  d *= gain * (1 - BREATH.dip * Math.max(0, -Math.cos((2 * Math.PI * t) / BREATH.period)) ** 2);
  return Math.min(BODY_PEAK, Math.max(0, d));
}

export function glitchRow(seat: Seat, t: number, jolt = false): number | undefined {
  if (seat.glitchMs === 0) return undefined;
  const first = Math.ceil(CROWN * seat.rows - 0.5);
  const count = Math.ceil(SKIRT * seat.rows - 0.5) - first;
  if (jolt) return first + Math.floor(hash(seat.seed, Math.floor(t), 2, GLITCH_LAYER) * count);
  let at = 0;
  for (let k = 0; ; k++) {
    at += 3 + 4 * hash(seat.seed, k, 0, GLITCH_LAYER);
    if (at > t) return undefined;
    if (t < at + seat.glitchMs / 1000) {
      return first + Math.floor(hash(seat.seed, k, 1, GLITCH_LAYER) * count);
    }
  }
}
