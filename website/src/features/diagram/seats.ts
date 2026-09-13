export const CELL_WIDTH = 7;
export const CELL_HEIGHT = 11;

export type SeatName = 'planner' | 'implementer' | 'reviewer';
export type Palette = 'blue' | 'green' | 'mixed';
export type Cell = { readonly c: number; readonly r: number };

export type Seat = {
  readonly shape: SeatName;
  readonly cols: number;
  readonly rows: number;
  readonly palette: Palette;
  readonly frequency: number;
  readonly tickRate: number;
  readonly glitchMs: number;
  readonly gaze: Cell;
  readonly seed: number;
};

export const SEATS: Readonly<Record<SeatName, Seat>> = {
  planner: {
    shape: 'planner',
    cols: 30,
    rows: 25,
    palette: 'blue',
    frequency: 6,
    tickRate: 12,
    glitchMs: 160,
    gaze: { c: 1, r: 0 },
    seed: 1,
  },
  implementer: {
    shape: 'implementer',
    cols: 26,
    rows: 22,
    palette: 'green',
    frequency: 12,
    tickRate: 12,
    glitchMs: 90,
    gaze: { c: -1, r: 0 },
    seed: 2,
  },
  reviewer: {
    shape: 'reviewer',
    cols: 22,
    rows: 18,
    palette: 'mixed',
    frequency: 4,
    tickRate: 8,
    glitchMs: 0,
    gaze: { c: -1, r: -1 },
    seed: 3,
  },
};
