import { expect, test } from 'vitest';
import { hash, valueNoise } from './noise';

test('hash spreads evenly across deciles and repeats for the same inputs', () => {
  const samples = Array.from({ length: 10_000 }, (_, i) => hash(7, i, i * 3, -i));
  expect(Math.min(...samples)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...samples)).toBeLessThan(1);
  for (let decile = 0; decile < 10; decile++) {
    const share = samples.filter((h) => Math.floor(h * 10) === decile).length / samples.length;
    expect(share, `decile ${decile}`).toBeGreaterThanOrEqual(0.08);
    expect(share, `decile ${decile}`).toBeLessThanOrEqual(0.12);
  }
  expect(hash(7, 1, 2, 3)).toBe(hash(7, 1, 2, 3));
  expect(hash(7, 1, 2, 3)).not.toBe(hash(8, 1, 2, 3));
});

test('valueNoise moves smoothly between neighbouring samples on every axis', () => {
  const walks = [
    (x: number) => valueNoise(3, x, 0.5, 0.25),
    (y: number) => valueNoise(3, 0.5, y, 0.25),
    (z: number) => valueNoise(3, 0.5, 0.25, z),
  ];
  for (const walk of walks) {
    let previous = walk(0);
    for (let step = 1; step <= 300; step++) {
      const next = walk(step * 0.2);
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThanOrEqual(1);
      expect(Math.abs(next - previous)).toBeLessThan(0.35);
      previous = next;
    }
  }
  expect(valueNoise(3, 1.7, 2.2, 0.4)).toBe(valueNoise(3, 1.7, 2.2, 0.4));
});
