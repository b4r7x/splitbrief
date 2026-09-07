import { expect, test } from 'vitest';
import { placeFragments, type Rect, travelBand } from './mount';
import { POOL } from './pool';

const viewport = { width: 1440, height: 900 };
const headline: Rect = { left: 64, top: 285, right: 600, bottom: 700 };
const lede: Rect = { left: 64, top: 716, right: 608, bottom: 790 };
const cta: Rect = { left: 64, top: 820, right: 348, bottom: 866 };
const planner: Rect = { left: 632, top: 320, right: 842, bottom: 596 };
const exclusions = [headline, lede, cta, planner];

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

test('28 fragments hover clear of the headline, lede, CTA and ghosts for their whole travel', () => {
  const placed = placeFragments(viewport, exclusions);
  expect(placed).toHaveLength(28);
  expect(new Set(placed.map(({ text }) => text)).size).toBe(POOL.length);
  const bands = placed.map(({ text, x, y }) => travelBand(text, x, y));
  bands.forEach((band, i) => {
    for (const rect of exclusions) expect(intersects(band, rect), `${placed[i]?.text}`).toBe(false);
    for (const other of bands.slice(i + 1)) expect(intersects(band, other)).toBe(false);
  });
  for (const { x, y, duration, opacity, phase } of placed) {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(viewport.height + 120);
    expect(duration).toBeGreaterThanOrEqual(14);
    expect(duration).toBeLessThanOrEqual(28);
    expect(opacity).toBeGreaterThanOrEqual(0.18);
    expect(opacity).toBeLessThanOrEqual(0.35);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(1);
  }
});

test('the same viewport and exclusions place the same fragments every time', () => {
  expect(placeFragments(viewport, exclusions)).toEqual(placeFragments(viewport, exclusions));
  expect(placeFragments(viewport, [headline])).not.toEqual(placeFragments(viewport, exclusions));
  expect(placeFragments({ width: 390, height: 844 }, [])).not.toEqual(placeFragments(viewport, []));
});
