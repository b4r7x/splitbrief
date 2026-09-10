import { expect, test } from 'vitest';
import { cells, type FieldSpec, relit, share } from './dots';

const FIELDS: FieldSpec[] = [
  { seed: 2, cols: 44, rows: 7, profile: 'skyline' },
  { seed: 3, cols: 10, rows: 6, profile: 'column' },
  { seed: 5, cols: 36, rows: 7, profile: 'skyline' },
  { seed: 6, cols: 10, rows: 10, profile: 'column' },
  { seed: 7, cols: 60, rows: 6, profile: 'ground' },
  { seed: 8, cols: 10, rows: 8, profile: 'column' },
];

test('a field is deterministic', () => {
  for (const f of FIELDS) {
    expect(cells(f), `seed ${f.seed}`).toEqual(cells(f));
  }
  const a: FieldSpec = { seed: 2, cols: 44, rows: 7, profile: 'skyline' };
  expect(cells(a)).not.toEqual(cells({ ...a, seed: 3 }));
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
      expect(cell.alpha, label).toBeGreaterThanOrEqual(0.45);
      expect(cell.alpha, label).toBeLessThanOrEqual(1);
    }
  }
});

test('no row lights more than 35 % of its cells', () => {
  for (const f of FIELDS) {
    const counts = new Map<number, number>();
    for (const cell of cells(f)) {
      counts.set(cell.r, (counts.get(cell.r) ?? 0) + 1);
    }
    for (let r = 0; r < f.rows; r++) {
      expect((counts.get(r) ?? 0) / f.cols, `seed ${f.seed} row ${r}`).toBeLessThanOrEqual(0.35);
    }
  }
});

test('the six fields cover under 3 % of the lower page', () => {
  const lit = FIELDS.reduce((n, f) => n + cells(f).length, 0);
  expect(lit * 77).toBeLessThan(0.03 * 1440 * 1764);
});

test('the shimmer re-lights a few cells and only lit ones', () => {
  const f: FieldSpec = { seed: 7, cols: 60, rows: 6, profile: 'ground' };
  const lit = cells(f);
  const keys = new Set(lit.map((cell) => `${cell.c},${cell.r}`));
  let total = 0;
  for (let tick = 1; tick <= 20; tick++) {
    const next = relit(f, tick);
    total += next.length;
    for (const cell of next) {
      expect(keys.has(`${cell.c},${cell.r}`), `tick ${tick} ${cell.c},${cell.r}`).toBe(true);
    }
  }
  const mean = total / 20;
  expect(mean).toBeGreaterThanOrEqual(0.01 * lit.length);
  expect(mean).toBeLessThanOrEqual(0.12 * lit.length);
});

test('share is the profile', () => {
  for (let i = 0; i <= 20; i++) {
    const u = i / 20;
    expect(share('skyline', u, 0, 2), `u ${u}`).toBe(0);
  }
  for (let i = 0; i <= 20; i++) {
    const v = i / 20;
    expect(share('column', 0.5, v, 3), `v ${v}`).toBeGreaterThanOrEqual(share('column', 0, v, 3));
  }
});
