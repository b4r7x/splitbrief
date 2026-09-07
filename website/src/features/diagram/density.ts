import { hash, valueNoise } from '../../lib/noise';
import type { Cell, Seat } from './seats';
import { eye, inside, pupilCell } from './silhouette';

const NOISE_SPAN = 4;
const BODY_TOP = 0.42;
const BODY_BOTTOM = 0.86;
const CORE = { v: 0.6, rx: 0.5, ry: 0.85 };
const BODY_PEAK = 0.875;
const GLITCH_LAYER = -2;
const HALO_FLOOR = 0.05;
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
  let d = 0.42 + 0.42 * (1 - dist ** 4);
  if (r % 2 === 1) d *= 0.85;
  if (c % 2 === 1) d *= 0.88;
  if (!isSurrounded(seat, c, r)) d *= 0.45 + 0.45 * lift;
  d *= gain * (0.82 + 0.18 * Math.sin((2 * Math.PI * t) / seat.period + seat.phase));
  d += 0.18 * n;
  return Math.min(BODY_PEAK, d);
}

export function glitchRow(seat: Seat, t: number, jolt = false): number | undefined {
  if (seat.glitchMs === 0) return undefined;
  const first = Math.ceil(BODY_TOP * seat.rows - 0.5);
  const count = Math.ceil(BODY_BOTTOM * seat.rows - 0.5) - first;
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
