export const CELL_WIDTH = 7;
export const CELL_HEIGHT = 11;

export type SeatName = 'planner' | 'implementer' | 'reviewer';
export type Palette = 'blue' | 'green' | 'mixed';
export type Cell = { readonly c: number; readonly r: number };

export type Seat = {
  readonly cols: number;
  readonly rows: number;
  readonly palette: Palette;
  readonly period: number;
  readonly phase: number;
  readonly frequency: number;
  readonly tickRate: number;
  readonly glitchMs: number;
  readonly gain: number;
  readonly gaze: Cell;
  readonly seed: number;
};

export const SEATS: Readonly<Record<SeatName, Seat>> = {
  planner: {
    cols: 30,
    rows: 25,
    palette: 'blue',
    period: 6.5,
    phase: 0,
    frequency: 6,
    tickRate: 12,
    glitchMs: 160,
    gain: 1,
    gaze: { c: 1, r: 0 },
    seed: 1,
  },
  implementer: {
    cols: 26,
    rows: 22,
    palette: 'green',
    period: 2.8,
    phase: 2.1,
    frequency: 12,
    tickRate: 12,
    glitchMs: 90,
    gain: 1,
    gaze: { c: -1, r: 0 },
    seed: 2,
  },
  reviewer: {
    cols: 22,
    rows: 18,
    palette: 'mixed',
    period: 9,
    phase: 4.2,
    frequency: 4,
    tickRate: 8,
    glitchMs: 0,
    gain: 0.85,
    gaze: { c: -1, r: -1 },
    seed: 3,
  },
};
