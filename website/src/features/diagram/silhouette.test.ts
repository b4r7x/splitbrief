import { expect, test } from 'vitest';
import { type Cell, SEATS, type Seat, type SeatName } from './seats';
import { CROWN, eye, inside, pupilCell, SKIRT } from './silhouette';

const seats = Object.entries(SEATS);

function centre(seat: Seat, c: number, r: number): { u: number; v: number } {
  return { u: (c + 0.5) / seat.cols, v: (r + 0.5) / seat.rows };
}

function rowRuns(seat: Seat, r: number, isIn: (u: number, v: number) => boolean): number[] {
  const runs: number[] = [];
  let run = 0;
  for (let c = 0; c < seat.cols; c++) {
    const { u, v } = centre(seat, c, r);
    if (isIn(u, v)) run++;
    else if (run > 0) {
      runs.push(run);
      run = 0;
    }
  }
  if (run > 0) runs.push(run);
  return runs;
}

test.each(seats)('the %s silhouette mirrors left to right', (_, seat) => {
  let outside = 0;
  for (let r = 0; r < seat.rows; r++) {
    for (let c = 0; c < seat.cols; c++) {
      const { u, v } = centre(seat, c, r);
      expect(inside(u, v), `cell ${c},${r}`).toBe(inside(1 - u, v));
      expect(eye(u, v), `cell ${c},${r}`).toBe(eye(1 - u, v));
      if (!inside(u, v)) outside++;
    }
  }
  expect(outside).toBeGreaterThan(0);
});

// hero-diagram.png: the dome is a third as wide as the body on its first row and reaches the
// full width after seven of 25 rows; the body then stays full width down to the skirt.
test('the crown widens like the reference dome and the body is full width', () => {
  const seat = SEATS.planner;
  const widths = Array.from(
    { length: seat.rows },
    (_, r) => rowRuns(seat, r, inside).reduce((sum, run) => sum + run, 0) / seat.cols,
  );
  expect(widths[0]).toBeGreaterThanOrEqual(0.3);
  expect(widths[0]).toBeLessThanOrEqual(0.4);
  for (const [r, width] of widths.entries()) {
    const previous = widths[r - 1];
    if (r < 7 && previous !== undefined) expect(width, `row ${r}`).toBeGreaterThanOrEqual(previous);
    if (r >= 7 && r < Math.floor(SKIRT * seat.rows)) expect(width, `row ${r}`).toBe(1);
  }
  expect(Math.floor(CROWN * seat.rows)).toBeLessThanOrEqual(8);
});

// hero-diagram.png: the skirt dissolves into five two-column strands that thin to dots.
test('the skirt ends in five strands that thin toward the bottom', () => {
  const seat = SEATS.planner;
  const first = Math.ceil(SKIRT * seat.rows);
  let previous = seat.cols;
  for (let r = first; r < seat.rows; r++) {
    const runs = rowRuns(seat, r, inside);
    const filled = runs.reduce((sum, run) => sum + run, 0);
    expect(filled, `row ${r}`).toBeLessThanOrEqual(previous);
    previous = filled;
  }
  const last = rowRuns(seat, seat.rows - 1, inside);
  expect(last).toHaveLength(5);
  for (const run of last) expect(run).toBeLessThanOrEqual(2);
});

// hero-diagram.png: each eye is a four-cell-wide, four-row rounded void with the corners cut,
// and a nose of at least three body cells separates the two.
test('the eyes are two rounded 4x4 voids with a nose between them', () => {
  const seat = SEATS.planner;
  const rows = Array.from({ length: seat.rows }, (_, r) => rowRuns(seat, r, eye));
  const eyeRows = rows.map((runs, r) => ({ runs, r })).filter(({ runs }) => runs.length > 0);
  expect(eyeRows).toHaveLength(4);
  expect(eyeRows.map(({ runs }) => runs)).toEqual([
    [2, 2],
    [4, 4],
    [4, 4],
    [2, 2],
  ]);
  const middle = eyeRows[1]?.r ?? -1;
  let nose = 0;
  let seen = false;
  for (let c = 0; c < seat.cols; c++) {
    const { u, v } = centre(seat, c, middle);
    if (eye(u, v)) seen = nose === 0;
    else if (seen) nose++;
  }
  expect(nose).toBeGreaterThanOrEqual(3);
});

const pupilRows: [SeatName, { left: Cell; right: Cell }][] = [
  ['planner', { left: { c: 10, r: 10 }, right: { c: 20, r: 10 } }],
  ['implementer', { left: { c: 9, r: 10 }, right: { c: 19, r: 10 } }],
  ['reviewer', { left: { c: 9, r: 9 }, right: { c: 19, r: 9 } }],
];

test.each(pupilRows)(
  'the %s pupils sit half a cell off the void centres, toward the card, clear of the walls',
  (name, expected) => {
    const seat = SEATS[name];
    const left = pupilCell(seat, 'left');
    const right = pupilCell(seat, 'right');
    expect({ left, right }).toEqual(expected);
    for (const pupil of [left, right]) {
      for (const dc of [-1, 0, 1]) {
        const { u, v } = centre(seat, pupil.c + dc, pupil.r);
        expect(eye(u, v), `cell ${pupil.c + dc},${pupil.r}`).toBe(true);
      }
    }
  },
);
