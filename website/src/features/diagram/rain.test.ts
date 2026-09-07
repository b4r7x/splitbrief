import { expect, test } from 'vitest';
import { rainPhase, rainPoints } from './rain';

const ticks = [106.4, 509.2];

test('each tick gets a sparse seeded fall of . and : that thins toward the tick', () => {
  const points = rainPoints(ticks);
  expect(points).toEqual(rainPoints(ticks));
  for (const x of ticks) {
    const column = points.filter((point) => Math.abs(point.x - x) <= 21);
    expect(column.length).toBeLessThanOrEqual(0.3 * 6 * 9);
    expect(column.length).toBeGreaterThanOrEqual(8);
    for (const point of column) {
      expect(point.y).toBeGreaterThanOrEqual(51.6);
      expect(point.y).toBeLessThan(150.5);
      expect('.:').toContain(point.glyph);
    }
    const upper = column.filter((point) => point.y < 101).length;
    expect(upper).toBeGreaterThan(column.length - upper);
  }
  expect(points.length).toBe(
    ticks.reduce((sum, x) => sum + points.filter((point) => Math.abs(point.x - x) <= 21).length, 0),
  );
});

test('each generation carries every surviving glyph one row down and re-seeds the top', () => {
  const before = rainPoints(ticks, 3);
  const after = rainPoints(ticks, 4);
  const row = (y: number): number => Math.round((y - 51.6) / 11);
  for (const point of after) {
    if (row(point.y) === 0) continue;
    const parent = before.find((p) => p.x === point.x && row(p.y) === row(point.y) - 1);
    expect(parent?.glyph, `${point.x},${point.y}`).toBe(point.glyph);
  }
  expect(after.some((point) => point.y === 51.6)).toBe(true);
  expect(rainPhase(0)).toEqual({ generation: 0, offset: 0 });
  expect(rainPhase(10 / 14)).toEqual({ generation: 0, offset: 10 });
  expect(rainPhase(11 / 14)).toEqual({ generation: 1, offset: 0 });
});
