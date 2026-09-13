import type { Cell, Seat } from './seats';

export type Side = 'left' | 'right';

export const CROWN = 0.42;
export const SKIRT = 0.84;
const EYE_X: Readonly<Record<Side, number>> = { left: 1 / 3, right: 2 / 3 };
const EYE_Y = 0.4;
const PROFILES = {
  planner: { crown: 0.42, lean: 0, taper: 0, lobes: 4, eyeX: 0.12, eyeY: 0.14 },
  implementer: { crown: 0.35, lean: 0.075, taper: 0.12, lobes: 3, eyeX: 0.11, eyeY: 0.13 },
  reviewer: { crown: 0.3, lean: 0, taper: 0.2, lobes: 3, eyeX: 0.135, eyeY: 0.1 },
};

export function inside(seat: Seat, u: number, v: number): boolean {
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  const { crown, lean, taper, lobes } = PROFILES[seat.shape];
  const x = u - lean * (1 - v);
  const radius = 0.48 - taper * Math.max(0, v - crown);
  if (v < crown) return ((x - 0.5) / radius) ** 2 + ((v - crown) / crown) ** 2 <= 1;
  if (Math.abs(x - 0.5) > radius) return false;
  if (v < SKIRT) return true;
  return v <= SKIRT + (1 - SKIRT) * Math.abs(Math.sin(x * lobes * Math.PI));
}

function inEye(seat: Seat, u: number, v: number, side: Side): boolean {
  const profile = PROFILES[seat.shape];
  return ((u - EYE_X[side]) / profile.eyeX) ** 2 + ((v - EYE_Y) / profile.eyeY) ** 2 <= 1;
}

export function eye(seat: Seat, u: number, v: number): boolean {
  return inEye(seat, u, v, 'left') || inEye(seat, u, v, 'right');
}

export function pupilCell(seat: Seat, side: Side, gaze: Cell = seat.gaze): Cell {
  const r = Math.floor(EYE_Y * seat.rows) + gaze.r;
  const v = (r + 0.5) / seat.rows;
  let first = -1;
  let last = -1;
  for (let c = 0; c < seat.cols; c++) {
    if (!inEye(seat, (c + 0.5) / seat.cols, v, side)) continue;
    if (first < 0) first = c;
    last = c;
  }
  return { c: Math.floor((first + last) / 2 + gaze.c / 2), r };
}
