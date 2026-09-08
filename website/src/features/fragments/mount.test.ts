import { expect, test } from 'vitest';
import { placeFragments, type Rect, travelBand } from './mount';
import { POOL } from './pool';

const viewport = { width: 1440, height: 900 };
const nav: Rect = { left: 0, top: 0, right: 1440, bottom: 96 };
const headline = domRect({ left: 64, top: 285, right: 600, bottom: 700 });
const lede: Rect = { left: 64, top: 716, right: 608, bottom: 790 };
const cta: Rect = { left: 64, top: 820, right: 348, bottom: 866 };
const planner: Rect = { left: 632, top: 320, right: 842, bottom: 596 };
const keepClear = { text: [headline, lede, cta], marks: [nav, planner] };
const exclusions = [...keepClear.text, ...keepClear.marks];

function domRect({ left, top, right, bottom }: Rect): Rect {
  return Object.create(
    Object.defineProperties(
      {},
      {
        left: { get: () => left },
        top: { get: () => top },
        right: { get: () => right },
        bottom: { get: () => bottom },
      },
    ),
  );
}

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

test('all 20 fragments hover on screen, clear of the header band, the type (a DOMRect, read through its getters), the ghosts and each other', () => {
  const placed = placeFragments(viewport, keepClear);
  expect(placed).toHaveLength(POOL.length);
  expect(new Set(placed.map(({ text }) => text)).size).toBe(POOL.length);
  const bands = placed.map(({ text, x, y }) => travelBand(text, x, y));
  bands.forEach((band, i) => {
    for (const rect of exclusions) expect(intersects(band, rect), `${placed[i]?.text}`).toBe(false);
    for (const rect of keepClear.text) {
      const beside = { ...rect, left: rect.left - 24, right: rect.right + 24 };
      const ink = { ...band, left: band.left + 6, right: band.right - 6 };
      expect(intersects(ink, beside), `${placed[i]?.text} sits on a text line`).toBe(false);
    }
    for (const other of bands.slice(i + 1)) expect(intersects(band, other)).toBe(false);
  });
  for (const { x, y, duration, opacity, phase } of placed) {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(96);
    expect(y).toBeLessThanOrEqual(viewport.height - 11);
    expect(duration).toBeGreaterThanOrEqual(14);
    expect(duration).toBeLessThanOrEqual(28);
    expect(opacity).toBeGreaterThanOrEqual(0.18);
    expect(opacity).toBeLessThanOrEqual(0.35);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(1);
  }
});

test('the same viewport and exclusions place the same fragments every time', () => {
  const none = { text: [], marks: [] };
  expect(placeFragments(viewport, keepClear)).toEqual(placeFragments(viewport, keepClear));
  expect(placeFragments(viewport, { text: [headline], marks: [] })).not.toEqual(
    placeFragments(viewport, keepClear),
  );
  expect(placeFragments({ width: 390, height: 844 }, none)).not.toEqual(
    placeFragments(viewport, none),
  );
});
