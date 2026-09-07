import { expect, test } from 'vitest';
import { length, offsetPath, type Polyline, pointAt } from './route-geometry';

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
