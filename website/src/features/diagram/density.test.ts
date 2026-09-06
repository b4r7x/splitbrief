import { expect, test } from 'vitest';
import { density, glitchRow } from './density';
import { SEATS, type Seat, type SeatName } from './seats';
import { eye, pupilCell } from './silhouette';

const seats = Object.entries(SEATS);

function grid(seat: Seat, t: number): number[][] {
  return Array.from({ length: seat.rows }, (_, r) =>
    Array.from({ length: seat.cols }, (_, c) => density(seat, c, r, t)),
  );
}

test.each(seats)('the %s field is deterministic and stays within [0, 1]', (_, seat) => {
  for (const t of [0, 0.37, 2.5, 11.9]) {
    const cells = grid(seat, t);
    expect(cells).toEqual(grid(seat, t));
    expect(Math.min(...cells.flat())).toBeGreaterThanOrEqual(0);
    expect(Math.max(...cells.flat())).toBeLessThanOrEqual(1);
  }
});

test.each(seats)('the %s eyes are voids with exactly one pupil each', (_, seat) => {
  const pupils = [pupilCell(seat, 'left'), pupilCell(seat, 'right')];
  for (const t of [0, 1.3]) {
    let solid = 0;
    for (let r = 0; r < seat.rows; r++) {
      for (let c = 0; c < seat.cols; c++) {
        if (!eye((c + 0.5) / seat.cols, (r + 0.5) / seat.rows)) continue;
        const d = density(seat, c, r, t);
        if (pupils.some((pupil) => pupil.c === c && pupil.r === r)) {
          expect(d, `pupil ${c},${r}`).toBe(1);
          solid++;
        } else {
          expect(d, `eye cell ${c},${r}`).toBe(0);
        }
      }
    }
    expect(solid).toBe(2);
  }
});

test('the core is denser than the rim and the rim fades into a faint halo', () => {
  const seat = SEATS.planner;
  const cells = grid(seat, 0);
  const mean = (values: number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const core = cells.slice(13, 16).flatMap((row) => row.slice(12, 18));
  const rim = cells.slice(13, 16).flatMap((row) => [...row.slice(0, 2), ...row.slice(28)]);
  expect(mean(core)).toBeGreaterThan(mean(rim) + 0.3);
  expect(density(seat, 0, 0, 0)).toBe(0);
  const halo = density(seat, 8, 0, 0);
  expect(halo).toBeGreaterThanOrEqual(0.08);
  expect(halo).toBeLessThanOrEqual(0.18);
});

function glitches(seat: Seat): { start: number; end: number; row: number }[] {
  const events: { start: number; end: number; row: number }[] = [];
  let open: { start: number; row: number } | undefined;
  for (let i = 0; i <= 12_000; i++) {
    const t = i / 200;
    const row = glitchRow(seat, t);
    if (row !== undefined && !open) open = { start: t, row };
    if (row === undefined && open) {
      events.push({ ...open, end: t });
      open = undefined;
    }
  }
  return events;
}

const glitchRows: [SeatName, number][] = [
  ['planner', 0.16],
  ['implementer', 0.09],
];

test.each(glitchRows)('the %s shifts one body row every 3–7 s for %s s', (name, duration) => {
  const seat = SEATS[name];
  const events = glitches(seat);
  expect(events.length).toBeGreaterThanOrEqual(8);
  events.forEach((event, i) => {
    expect(event.end - event.start).toBeCloseTo(duration, 1);
    const v = (event.row + 0.5) / seat.rows;
    expect(v).toBeGreaterThanOrEqual(0.42);
    expect(v).toBeLessThan(0.86);
    const previous = events[i - 1];
    if (previous) {
      expect(event.start - previous.start).toBeGreaterThanOrEqual(3);
      expect(event.start - previous.start).toBeLessThanOrEqual(7.01);
    }
  });
});

test('the reviewer never glitches', () => {
  expect(glitches(SEATS.reviewer)).toEqual([]);
});
