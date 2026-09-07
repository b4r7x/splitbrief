import type { Cell, Seat } from './seats';

export type Side = 'left' | 'right';

const CROWN = 0.42;
const SKIRT = 0.86;
const EYE_X: Readonly<Record<Side, number>> = { left: 0.34, right: 0.66 };
const EYE_Y = 0.4;
const EYE_RX = 0.11;
const EYE_RY = 0.13;

export function inside(u: number, v: number): boolean {
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  if (v < CROWN) return ((u - 0.5) / 0.5) ** 2 + ((v - CROWN) / CROWN) ** 2 <= 1;
  if (v < SKIRT) return true;
  return v <= SKIRT + (1 - SKIRT) * Math.abs(Math.sin(u * 4 * Math.PI));
}

function inEye(u: number, v: number, side: Side): boolean {
  return ((u - EYE_X[side]) / EYE_RX) ** 2 + ((v - EYE_Y) / EYE_RY) ** 2 <= 1;
}

export function eye(u: number, v: number): boolean {
  return inEye(u, v, 'left') || inEye(u, v, 'right');
}

export function pupilCell(seat: Seat, side: Side, gaze: Cell = seat.gaze): Cell {
  const r = Math.floor(EYE_Y * seat.rows) + gaze.r;
  const v = (r + 0.5) / seat.rows;
  let first = -1;
  let last = -1;
  for (let c = 0; c < seat.cols; c++) {
    if (!inEye((c + 0.5) / seat.cols, v, side)) continue;
    if (first < 0) first = c;
    last = c;
  }
  return { c: Math.floor((first + last) / 2 + gaze.c / 2), r };
}
