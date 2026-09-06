import { hash, valueNoise } from '../../lib/noise';
import type { Seat } from './seats';
import { eye, inside, pupilCell } from './silhouette';

const NOISE_SPAN = 4;
const HALO_REACH = 2;
const BODY_TOP = 0.42;
const BODY_BOTTOM = 0.86;
const GLITCH_LAYER = -2;

function isBody(seat: Seat, c: number, r: number): boolean {
  const u = (c + 0.5) / seat.cols;
  const v = (r + 0.5) / seat.rows;
  return inside(u, v) && !eye(u, v);
}

function isSurrounded(seat: Seat, c: number, r: number): boolean {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!isBody(seat, c + dc, r + dr)) return false;
    }
  }
  return true;
}

function isNearRim(seat: Seat, c: number, r: number): boolean {
  for (let dr = -HALO_REACH; dr <= HALO_REACH; dr++) {
    for (let dc = -HALO_REACH; dc <= HALO_REACH; dc++) {
      if (inside((c + dc + 0.5) / seat.cols, (r + dr + 0.5) / seat.rows)) return true;
    }
  }
  return false;
}

function isPupil(seat: Seat, c: number, r: number): boolean {
  const left = pupilCell(seat, 'left');
  const right = pupilCell(seat, 'right');
  return (left.c === c && left.r === r) || (right.c === c && right.r === r);
}

export function density(seat: Seat, c: number, r: number, t: number): number {
  const u = (c + 0.5) / seat.cols;
  const v = (r + 0.5) / seat.rows;
  const tick = Math.floor(t * seat.frequency);
  const n = valueNoise(seat.seed, c / NOISE_SPAN, r / NOISE_SPAN, tick / NOISE_SPAN);
  if (!inside(u, v)) return isNearRim(seat, c, r) ? seat.gain * (0.08 + 0.1 * n) : 0;
  if (eye(u, v)) return isPupil(seat, c, r) ? 1 : 0;
  const dist = Math.min(1, Math.hypot((u - 0.5) / 0.5, (v - 0.5) / 0.5));
  let d = 0.55 + 0.45 * (1 - dist * dist);
  if (r % 2 === 1) d *= 0.72;
  if (!isSurrounded(seat, c, r)) d *= 0.45;
  d *= 0.82 + 0.18 * Math.sin((2 * Math.PI * t) / seat.period + seat.phase);
  d += 0.18 * n;
  return Math.min(1, seat.gain * d);
}

export function glitchRow(seat: Seat, t: number): number | undefined {
  if (seat.glitchMs === 0) return undefined;
  const first = Math.ceil(BODY_TOP * seat.rows - 0.5);
  const count = Math.ceil(BODY_BOTTOM * seat.rows - 0.5) - first;
  let at = 0;
  for (let k = 0; ; k++) {
    at += 3 + 4 * hash(seat.seed, k, 0, GLITCH_LAYER);
    if (at > t) return undefined;
    if (t < at + seat.glitchMs / 1000) {
      return first + Math.floor(hash(seat.seed, k, 1, GLITCH_LAYER) * count);
    }
  }
}
