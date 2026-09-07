import { expect, test } from 'vitest';
import { GLYPHS, glyphFor, tintFor } from './atlas';
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
  expect(tintFor(planner, 0.2, 0.5)).toBe('blue-dim');
  expect(tintFor(planner, 0.5, 0.5)).toBe('blue');
  expect(tintFor(planner, 0.9, 0.5)).toBe('blue');
  expect(tintFor(planner, 0.9, 0.11)).toBe('spark');
  expect(tintFor(planner, 0.9, 0.12)).toBe('blue');
  expect(tintFor(SEATS.implementer, 0.2, 0.5)).toBe('green-dim');
  expect(tintFor(SEATS.implementer, 0.5, 0.5)).toBe('green');
});

test('the reviewer mixes blue-dim, green-dim and spark at 55/35/10', () => {
  const reviewer = SEATS.reviewer;
  expect(tintFor(reviewer, 0.5, 0.54)).toBe('blue-dim');
  expect(tintFor(reviewer, 0.5, 0.55)).toBe('green-dim');
  expect(tintFor(reviewer, 0.5, 0.89)).toBe('green-dim');
  expect(tintFor(reviewer, 0.5, 0.9)).toBe('spark');
});
