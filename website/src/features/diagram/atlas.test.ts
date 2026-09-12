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

// hero-diagram.png: the dome's sparse ':' and '=' glyphs are drawn in the full accent — only the
// halo dots are dimmer; sparks are a few bright white glyphs, never a dim glyph drawn white; every
// pupil is a white ring.
test('lab seats ramp from dim to accent, with only bright cells sparking white', () => {
  const planner = SEATS.planner;
  expect(tintFor(planner, 0.125, 0.5)).toBe('blue-dim');
  expect(tintFor(planner, 0.25, 0.5)).toBe('blue');
  expect(tintFor(planner, 0.9, 0.5)).toBe('blue');
  expect(tintFor(planner, 0.9, 0.04)).toBe('spark');
  expect(tintFor(planner, 0.9, 0.05)).toBe('blue');
  expect(tintFor(planner, 0.5, 0.04)).toBe('blue');
  expect(tintFor(planner, 1, 0.5)).toBe('spark');
  expect(tintFor(SEATS.implementer, 0.125, 0.5)).toBe('green-dim');
  expect(tintFor(SEATS.implementer, 0.5, 0.5)).toBe('green');
});

test('the reviewer mixes both labs, blue-led, with the same dim ramp and sparks', () => {
  const reviewer = SEATS.reviewer;
  expect(tintFor(reviewer, 0.5, 0.64)).toBe('blue');
  expect(tintFor(reviewer, 0.125, 0.64)).toBe('blue-dim');
  expect(tintFor(reviewer, 0.5, 0.65)).toBe('green');
  expect(tintFor(reviewer, 0.125, 0.9)).toBe('green-dim');
  expect(tintFor(reviewer, 0.9, 0.04)).toBe('spark');
});
