import { expect, test } from 'vitest';
import { colourFor, GLYPHS, glyphFor } from './atlas';
import { SEATS } from './seats';

test('glyphFor walks all nine glyphs from empty to solid and clamps outside the range', () => {
  const seen = new Set<string>();
  for (let i = 0; i <= 100; i++) seen.add(glyphFor(i / 100));
  expect([...seen].join('')).toBe(GLYPHS);
  expect(glyphFor(-1)).toBe(' ');
  expect(glyphFor(1)).toBe('@');
  expect(glyphFor(2)).toBe('@');
});

test('lab seats ramp from dim to accent, with sparks drawn white', () => {
  const planner = SEATS.planner;
  expect(colourFor(planner, 0.2, 0.5)).toEqual({ tint: 'blue-dim', alpha: 0.55 });
  expect(colourFor(planner, 0.5, 0.5).tint).toBe('blue');
  expect(colourFor(planner, 0.5, 0.5).alpha).toBeCloseTo(0.8);
  expect(colourFor(planner, 0.9, 0.5)).toEqual({ tint: 'blue', alpha: 1 });
  expect(colourFor(planner, 0.9, 0.11).tint).toBe('spark');
  expect(colourFor(planner, 0.9, 0.12).tint).toBe('blue');
  expect(colourFor(SEATS.implementer, 0.2, 0.5).tint).toBe('green-dim');
  expect(colourFor(SEATS.implementer, 0.5, 0.5).tint).toBe('green');
});

test('the reviewer mixes blue-dim, green-dim and spark at 55/35/10', () => {
  const reviewer = SEATS.reviewer;
  expect(colourFor(reviewer, 0.5, 0.54).tint).toBe('blue-dim');
  expect(colourFor(reviewer, 0.5, 0.55).tint).toBe('green-dim');
  expect(colourFor(reviewer, 0.5, 0.89).tint).toBe('green-dim');
  expect(colourFor(reviewer, 0.5, 0.9).tint).toBe('spark');
  expect(colourFor(reviewer, 0.2, 0.2).alpha).toBe(0.55);
  expect(colourFor(reviewer, 0.9, 0.2).alpha).toBe(1);
});
