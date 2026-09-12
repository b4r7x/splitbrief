import { expect, test } from 'vitest';
import { CELL, cellRect, cells, density, type FieldSpec, latticeField, relit, share } from './dots';

const EDGE: FieldSpec = {
  seed: 31,
  profile: 'edge',
  flip: false,
  rim: true,
  level: 1,
  left: 8,
  top: 120,
  cols: 16,
  rows: 260,
};
const SKYLINE: FieldSpec = {
  seed: 40,
  profile: 'skyline',
  flip: false,
  rim: false,
  level: 1,
  left: 8,
  top: 1480,
  cols: 64,
  rows: 16,
};
const GROUND: FieldSpec = {
  seed: 33,
  profile: 'ground',
  flip: false,
  rim: false,
  level: 1,
  left: 926,
  top: 988,
  cols: 123,
  rows: 9,
};
const COLUMN: FieldSpec = {
  seed: 50,
  profile: 'column',
  flip: false,
  rim: false,
  level: 1,
  left: 1800,
  top: 1340,
  cols: 14,
  rows: 22,
};
const FIELDS: FieldSpec[] = [
  EDGE,
  { ...EDGE, seed: 32, flip: true, rim: false, level: 0.6, left: 1800 },
  SKYLINE,
  GROUND,
  COLUMN,
];

function litShare(spec: FieldSpec): number {
  return cells(spec).length / (spec.cols * spec.rows);
}

test('a field is deterministic and seeded', () => {
  for (const f of FIELDS) expect(cells(f), `seed ${f.seed}`).toEqual(cells(f));
  expect(cells(EDGE)).not.toEqual(cells({ ...EDGE, seed: 3 }));
});

test('every cell is inside its grid with a legal glyph and alpha', () => {
  for (const f of FIELDS) {
    for (const cell of cells(f)) {
      const label = `seed ${f.seed} ${cell.c},${cell.r}`;
      expect(cell.c, label).toBeGreaterThanOrEqual(0);
      expect(cell.c, label).toBeLessThan(f.cols);
      expect(cell.r, label).toBeGreaterThanOrEqual(0);
      expect(cell.r, label).toBeLessThan(f.rows);
      expect(cell.glyph === '.' || cell.glyph === ':', label).toBe(true);
      expect(cell.alpha, label).toBeGreaterThanOrEqual(0.3);
      expect(cell.alpha, label).toBeLessThanOrEqual(0.7);
    }
    const bright = cells(f).filter((cell) => cell.bright).length / cells(f).length;
    expect(bright, `seed ${f.seed}`).toBeGreaterThan(0.05);
    expect(bright, `seed ${f.seed}`).toBeLessThan(0.3);
  }
});

test('the edge columns stay sparse, the local fields stay under a third lit', () => {
  expect(litShare(EDGE)).toBeGreaterThan(0.02);
  expect(litShare(EDGE)).toBeLessThan(0.12);
  for (const f of FIELDS.slice(2)) {
    expect(litShare(f), `seed ${f.seed}`).toBeGreaterThan(0.02);
    expect(litShare(f), `seed ${f.seed}`).toBeLessThan(0.34);
  }
});

test('an edge column is densest on the page edge and fades out over its last rows', () => {
  for (const spec of [EDGE, { ...EDGE, flip: true }]) {
    const rim = spec.flip ? (c: number) => c >= spec.cols - 2 : (c: number) => c < 2;
    const belowHero = cells(spec).filter((cell) => rim(cell.c) && cell.r > 0.5 * spec.rows);
    const inHero = cells(spec).filter((cell) => rim(cell.c) && cell.r < 0.25 * spec.rows);
    expect(
      belowHero.length / 0.5,
      `rim thickens below the hero, flip ${spec.flip}`,
    ).toBeGreaterThan(inHero.length / 0.25);
    const outer = spec.flip ? (c: number) => c >= spec.cols - 4 : (c: number) => c < 4;
    const inner = spec.flip ? (c: number) => c < 4 : (c: number) => c >= spec.cols - 4;
    const mean = (pick: (c: number) => boolean): number => {
      let sum = 0;
      let n = 0;
      for (let c = 0; c < spec.cols; c++) {
        if (!pick(c)) continue;
        for (let r = 0; r < spec.rows; r++) {
          sum += share(spec, c, r);
          n++;
        }
      }
      return sum / n;
    };
    expect(mean(outer), `flip ${spec.flip}`).toBeGreaterThan(1.5 * mean(inner));
  }
  const lit = cells(EDGE);
  const middle = lit.filter((cell) => cell.r >= 0.55 * EDGE.rows && cell.r < 0.7 * EDGE.rows);
  const tail = lit.filter((cell) => cell.r >= 0.85 * EDGE.rows);
  expect(tail.length).toBeLessThan(middle.length);
  expect(tail.length).toBeGreaterThan(0);
});

test('the rim keeps a grain between its streaks, sparse beside the hero and full below it', () => {
  for (let r = 0; r < 0.85 * EDGE.rows; r++) {
    const v = (r + 0.5) / EDGE.rows;
    expect(share(EDGE, 0, r), `row ${r}`).toBeGreaterThanOrEqual(v < 0.8 ? 0.1 : 0.3);
  }
  expect(share(EDGE, 0, 20)).toBeLessThan(share(EDGE, 0, 220));
  const lit = new Set(
    cells(EDGE)
      .filter((cell) => cell.c === 0)
      .map((cell) => cell.r),
  );
  let gap = 0;
  let longest = 0;
  for (let r = Math.ceil(0.35 * EDGE.rows); r < 0.85 * EDGE.rows; r++) {
    gap = lit.has(r) ? 0 : gap + 1;
    longest = Math.max(longest, gap);
  }
  expect(longest).toBeLessThanOrEqual(12);
});

test('an edge column never steps: neighbouring 44px bands of expected density differ by under a quarter', () => {
  for (const spec of [EDGE, { ...EDGE, seed: 32, flip: true, rim: false, level: 0.35 }]) {
    const band = (from: number): number => {
      let sum = 0;
      for (let r = from; r < from + 4; r++) sum += density(spec, r);
      return sum / 4;
    };
    for (let r = 0; r + 8 <= spec.rows; r += 4) {
      const a = band(r);
      const b = band(r + 4);
      expect(Math.abs(a - b) / Math.max(a, b), `rows ${r}..${r + 8}`).toBeLessThanOrEqual(0.25);
    }
    const drawn = cells(spec).length / (spec.cols * spec.rows);
    let expected = 0;
    for (let r = 0; r < spec.rows; r++) expected += density(spec, r);
    expect(drawn / (expected / spec.rows)).toBeGreaterThan(0.7);
    expect(drawn / (expected / spec.rows)).toBeLessThan(1.4);
  }
});

test('a skyline is columns of runs standing on its base; a column is densest in its middle', () => {
  const skyline = SKYLINE;
  for (let c = 0; c < skyline.cols; c++) expect(share(skyline, c, 0)).toBeLessThan(0.02);
  const lit = cells(skyline);
  const base = lit.filter((cell) => cell.r === skyline.rows - 1).length;
  const crown = lit.filter((cell) => cell.r < skyline.rows / 4).length;
  expect(base).toBeGreaterThan(skyline.cols / 4);
  expect(crown).toBeLessThan(base / 2);
  const column = COLUMN;
  for (let r = 0; r < column.rows; r++) {
    expect(share(column, 7, r)).toBeGreaterThanOrEqual(share(column, 0, r));
  }
});

test('the shimmer changes only the brightness of a few lit cells per tick, under 5 % a second', () => {
  const lit = cells(GROUND);
  let total = 0;
  for (let tick = 1; tick <= 40; tick++) {
    const next = relit(GROUND, lit, tick);
    total += next.length;
    for (const { at, alpha } of next) {
      expect(lit[at], `tick ${tick}`).toBeDefined();
      expect(alpha, `tick ${tick}`).toBeGreaterThanOrEqual(0.3);
      expect(alpha, `tick ${tick}`).toBeLessThanOrEqual(0.7);
    }
  }

  const perSecond = (2 * total) / 40 / lit.length;
  expect(perSecond).toBeGreaterThan(0.005);
  expect(perSecond).toBeLessThanOrEqual(0.05);
});

test('a field snaps to the page lattice and reports cell rectangles on it', () => {
  const origin = { x: 8, y: 120 };
  const field = { seed: 1, profile: 'ground', flip: false, rim: false, level: 1 } as const;
  const spec = latticeField(field, { left: 926, top: 988, right: 1792, bottom: 1090 }, origin);
  if (!spec) throw new Error('field did not fit');
  expect((spec.left - origin.x) % CELL.width).toBe(0);
  expect((spec.top - origin.y) % CELL.height).toBe(0);
  expect(spec.left).toBeGreaterThanOrEqual(926);
  expect(spec.left + spec.cols * CELL.width).toBeLessThanOrEqual(1792);
  expect(spec.top).toBeGreaterThanOrEqual(988);
  expect(spec.top + spec.rows * CELL.height).toBeLessThanOrEqual(1090);
  expect(cellRect(spec, { c: 2, r: 1, glyph: '.', alpha: 1, bright: false })).toEqual({
    left: spec.left + 14,
    top: spec.top + 11,
    right: spec.left + 21,
    bottom: spec.top + 22,
  });
  expect(latticeField(field, { left: 926, top: 988, right: 930, bottom: 1090 }, origin)).toBe(
    undefined,
  );
});
