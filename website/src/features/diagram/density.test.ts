import { expect, test } from 'vitest';
import { glyphIndex } from './atlas';
import { density, glitchRow } from './density';
import { SEATS, type Seat, type SeatName } from './seats';
import { CROWN, eye, inside, pupilCell, SKIRT } from './silhouette';

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

test.each(seats)('the %s body never reaches the pupil glyph and weaves within a row', (_, seat) => {
  const isBody = (c: number, r: number): boolean => {
    const u = (c + 0.5) / seat.cols;
    const v = (r + 0.5) / seat.rows;
    return v >= CROWN && v < SKIRT && inside(u, v) && !eye(u, v);
  };
  let pairs = 0;
  let differing = 0;
  for (let r = 0; r < seat.rows; r++) {
    for (let c = 0; c < seat.cols; c++) {
      if (!isBody(c, r)) continue;
      expect(glyphIndex(density(seat, c, r, 0)), `cell ${c},${r}`).toBeLessThanOrEqual(7);
      if (!isBody(c + 1, r)) continue;
      pairs++;
      if (glyphIndex(density(seat, c, r, 0)) !== glyphIndex(density(seat, c + 1, r, 0)))
        differing++;
    }
  }
  expect(differing / pairs).toBeGreaterThanOrEqual(0.4);
});

// hero-diagram.png: no row or column stripes; the crown and the skirt are lighter than the
// middle, and the strands thin to dots at the bottom.
test.each(seats)(
  'the %s body has no stripes and fades toward the crown and the skirt',
  (_, seat) => {
    const cells = grid(seat, 0);
    const mean = (values: number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const body = (rows: number[]): number[] =>
      rows.flatMap(
        (r) =>
          cells[r]?.filter((_, c) => inside((c + 0.5) / seat.cols, (r + 0.5) / seat.rows)) ?? [],
      );
    const rowsOf = (from: number, to: number): number[] =>
      Array.from({ length: to - from }, (_, i) => from + i);
    const crownRows = rowsOf(0, Math.floor(CROWN * seat.rows));
    const middleRows = rowsOf(Math.ceil(0.5 * seat.rows), Math.floor(SKIRT * seat.rows));
    const skirtRows = rowsOf(Math.ceil(SKIRT * seat.rows), seat.rows);
    const middle = mean(body(middleRows));
    expect(mean(body(crownRows))).toBeLessThan(0.9 * middle);
    expect(mean(body(skirtRows))).toBeLessThan(0.7 * middle);
    expect(mean(body([seat.rows - 1]))).toBeLessThan(0.35 * middle);
    const even = mean(body(middleRows.filter((r) => r % 2 === 0)));
    const odd = mean(body(middleRows.filter((r) => r % 2 === 1)));
    expect(Math.abs(even - odd) / middle).toBeLessThan(0.1);
    const evenCols = mean(middleRows.flatMap((r) => cells[r]?.filter((_, c) => c % 2 === 0) ?? []));
    const oddCols = mean(middleRows.flatMap((r) => cells[r]?.filter((_, c) => c % 2 === 1) ?? []));
    expect(Math.abs(evenCols - oddCols) / middle).toBeLessThan(0.1);
  },
);

// Q01: the settled frame must not be a trough, and the trio must breathe as one. Rest is the
// bright state; the exhale is one dip of at most 8 % per 5 s, the same instant for every figure.
test('the three figures breathe together, and rest bright', () => {
  const body = (seat: Seat, t: number): number => {
    let sum = 0;
    let n = 0;
    for (let r = 0; r < seat.rows; r++) {
      for (let c = 0; c < seat.cols; c++) {
        const u = (c + 0.5) / seat.cols;
        const v = (r + 0.5) / seat.rows;
        if (v < CROWN || v >= SKIRT || !inside(u, v) || eye(u, v)) continue;
        sum += density(seat, c, r, t);
        n++;
      }
    }
    return sum / n;
  };
  const dips = seats.map(([name, seat]) => {
    const rest = body(seat, 0);
    for (const t of [4, 5]) expect(body(seat, t) / rest, `${name} at ${t}s`).toBeGreaterThan(0.97);
    const dip = body(seat, 2.5) / rest;
    expect(dip, `${name} at 2.5s`).toBeLessThan(0.95);
    expect(dip, `${name} at 2.5s`).toBeGreaterThan(1 / 1.3);
    return dip;
  });
  expect(Math.max(...dips) - Math.min(...dips)).toBeLessThan(0.05);
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
  const halo = density(seat, 9, 0, 0);
  expect(halo).toBeGreaterThanOrEqual(0.05);
  expect(halo).toBeLessThanOrEqual(0.15);
  expect(density(seat, 2, 0, 0)).toBe(0);
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
    expect(v).toBeGreaterThanOrEqual(CROWN);
    expect(v).toBeLessThan(SKIRT);
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
