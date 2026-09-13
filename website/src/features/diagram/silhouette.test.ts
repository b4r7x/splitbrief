import { expect, test } from 'vitest';
import { SEATS, type Seat } from './seats';
import { eye, inside, pupilCell } from './silhouette';

const seats = Object.entries(SEATS);

function centre(seat: Seat, c: number, r: number): { u: number; v: number } {
  return { u: (c + 0.5) / seat.cols, v: (r + 0.5) / seat.rows };
}

function rowRuns(seat: Seat, r: number, isIn: typeof inside): number[] {
  const runs: number[] = [];
  let run = 0;
  for (let c = 0; c < seat.cols; c++) {
    const { u, v } = centre(seat, c, r);
    if (isIn(seat, u, v)) run++;
    else if (run > 0) {
      runs.push(run);
      run = 0;
    }
  }
  if (run > 0) runs.push(run);
  return runs;
}

test.each(seats)('the %s has two separate eye voids inside its silhouette', (_, seat) => {
  let eyeRows = 0;
  for (let r = 0; r < seat.rows; r++) {
    const runs = rowRuns(seat, r, eye);
    if (runs.length) {
      expect(runs).toHaveLength(2);
      eyeRows++;
    }
    for (let c = 0; c < seat.cols; c++) {
      const { u, v } = centre(seat, c, r);
      if (eye(seat, u, v)) expect(inside(seat, u, v)).toBe(true);
    }
  }
  expect(eyeRows).toBeGreaterThanOrEqual(3);
  expect(inside(seat, -0.1, 0.5)).toBe(false);
  expect(inside(seat, 0.5, 1.1)).toBe(false);
});

test('the three characters have different outlines even on an equal monochrome grid', () => {
  const profiles = seats.map(([, seat]) =>
    Array.from({ length: 40 }, (_, r) =>
      Array.from({ length: 40 }, (_, c) =>
        Number(inside(seat, (c + 0.5) / 40, (r + 0.5) / 40)),
      ).join(''),
    ).join('\n'),
  );
  expect(new Set(profiles).size).toBe(3);
  expect(SEATS.planner.rows).toBeGreaterThan(SEATS.implementer.rows);
  expect(SEATS.implementer.rows).toBeGreaterThan(SEATS.reviewer.rows);
});

test.each(seats)('the %s pupils stay inside both eyes for every supported gaze', (_, seat) => {
  for (const r of [-1, 0, 1]) {
    for (const c of [-1, 0, 1]) {
      const pupils = [pupilCell(seat, 'left', { c, r }), pupilCell(seat, 'right', { c, r })];
      expect(pupils[0]).not.toEqual(pupils[1]);
      for (const pupil of pupils) {
        const { u, v } = centre(seat, pupil.c, pupil.r);
        expect(eye(seat, u, v), `${seat.shape}: ${c},${r}`).toBe(true);
        expect(inside(seat, u, v)).toBe(true);
      }
    }
  }
});
