import { expect, test } from 'vitest';
import { type Cell, SEATS, type Seat, type SeatName } from './seats';
import { eye, inside, pupilCell } from './silhouette';

const seats = Object.entries(SEATS);

function centre(seat: Seat, c: number, r: number): { u: number; v: number } {
  return { u: (c + 0.5) / seat.cols, v: (r + 0.5) / seat.rows };
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

test('the planner skirt ends in at least four scallops', () => {
  const seat = SEATS.planner;
  let runs = 0;
  let previous = false;
  for (let c = 0; c < seat.cols; c++) {
    const { u, v } = centre(seat, c, seat.rows - 1);
    const current = inside(u, v);
    if (current && !previous) runs++;
    previous = current;
  }
  expect(runs).toBeGreaterThanOrEqual(4);
});

const pupilRows: [SeatName, { left: Cell; right: Cell }][] = [
  ['planner', { left: { c: 10, r: 10 }, right: { c: 20, r: 10 } }],
  ['implementer', { left: { c: 8, r: 8 }, right: { c: 16, r: 8 } }],
  ['reviewer', { left: { c: 6, r: 6 }, right: { c: 13, r: 6 } }],
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
