import { expect, test } from 'vitest';
import { extend, length, offsetPath, type Polyline, parsePath, pointAt } from './route-geometry';

const route: Polyline = [
  { x: 0, y: 0 },
  { x: 30, y: 0 },
  { x: 30, y: 40 },
];

test('a two-leg polyline measures leg by leg and locates points along it', () => {
  expect(length(route)).toBe(70);
  expect(pointAt(route, 0)).toEqual({ x: 0, y: 0 });
  expect(pointAt(route, 10)).toEqual({ x: 10, y: 0 });
  expect(pointAt(route, 30)).toEqual({ x: 30, y: 0 });
  expect(pointAt(route, 50)).toEqual({ x: 30, y: 20 });
  expect(pointAt(route, 70)).toEqual({ x: 30, y: 40 });
  expect(pointAt(route, 99)).toEqual({ x: 30, y: 40 });
  expect(offsetPath(route)).toBe('path("M 0.0 0.0 L 30.0 0.0 L 30.0 40.0")');
});

test('a drawn route round-trips from its path data and extends past both ends along its legs', () => {
  expect(parsePath('M 0 0 L 30 0 L 30 40')).toEqual(route);
  expect(parsePath('M 296.4,447.6 L 296.4 516')).toEqual([
    { x: 296.4, y: 447.6 },
    { x: 296.4, y: 516 },
  ]);
  expect(() => parsePath('')).toThrow('no points');
  expect(extend(route, 8)).toEqual([
    { x: -8, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 48 },
  ]);
  expect(extend([{ x: 5, y: 5 }], 8)).toEqual([{ x: 5, y: 5 }]);
  expect(length(extend(route, 8))).toBe(86);
});
