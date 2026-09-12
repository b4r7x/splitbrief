import { expect, test } from 'vitest';
import { footprint, type Layer, placeFragments, type Rect } from './place';
import { HERO, lower } from './pool';

const POOL: readonly string[] = [
  'brief -> implementer',
  'typecheck · lint · test',
  'retry(3) -> escalate',
  'const brief = compile(spec)',
  'while (red) retry()',
  'promote(diff)',
  'evidence.jsonl',
  'real software',
  'lower spend',
  'fewer blind spots',
  'one file per brief',
  '0x2f 0x62 0x72',
  '[ 3 / 7 ]',
  '∴',
  '//',
  '→',
  'T1 ✓',
  'T2 ▸',
  'hash ok',
  'worktree',
];
const STRIP: Layer = { ...HERO.strip, pool: POOL };
const zone: Rect = { left: 0, top: 0, right: 1440, bottom: 900 };
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

test('all 20 fragments sit inside the zone, clear of the header band, the type (a DOMRect, read through its getters), the ghosts and each other', () => {
  const placed = placeFragments(zone, keepClear, STRIP);
  expect(placed).toHaveLength(POOL.length);
  expect(new Set(placed.map(({ text }) => text)).size).toBe(POOL.length);
  const bands = placed.map(({ text, x, y }) => footprint(text, x, y));

  bands.forEach((band, i) => {
    for (const rect of exclusions) expect(intersects(band, rect), `${placed[i]?.text}`).toBe(false);
    for (const rect of keepClear.text) {
      const beside = {
        left: rect.left - 24,
        top: rect.top,
        right: rect.right + 24,
        bottom: rect.bottom,
      };

      const ink = { ...band, left: band.left + 6, right: band.right - 6 };
      expect(intersects(ink, beside), `${placed[i]?.text} sits on a text line`).toBe(false);
    }
    for (const other of bands.slice(i + 1)) expect(intersects(band, other)).toBe(false);
  });
  for (const { x, y, duration, opacity, phase } of placed) {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(zone.bottom - 22);
    expect(duration).toBeGreaterThanOrEqual(14);
    expect(duration).toBeLessThanOrEqual(28);
    expect(opacity).toBeGreaterThanOrEqual(0.9);
    expect(opacity).toBeLessThanOrEqual(1);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(1);
  }
});

test('the same zone and exclusions place the same fragments every time', () => {
  const none = { text: [], marks: [] };
  expect(placeFragments(zone, keepClear, STRIP)).toEqual(placeFragments(zone, keepClear, STRIP));
  expect(placeFragments(zone, { text: [headline], marks: [] }, STRIP)).not.toEqual(
    placeFragments(zone, keepClear, STRIP),
  );
  expect(placeFragments({ left: 0, top: 0, right: 390, bottom: 844 }, none, STRIP)).not.toEqual(
    placeFragments(zone, none, STRIP),
  );
});

test('a two-line whisper is placed by its widest line and both lines, and skips a zone too shallow for them', () => {
  const twoLine = 'validates\nkeeps the bar high';
  expect(footprint(twoLine, 100, 200)).toEqual({
    left: 94,
    top: 194,
    right: 100 + 18 * 9 + 6,
    bottom: 200 + 44 + 6,
  });
  const layer: Layer = { ...HERO.reviewer, pool: [twoLine, '+'] };
  const shallow = { left: 0, top: 0, right: 400, bottom: 44 };
  expect(placeFragments(shallow, { text: [], marks: [] }, layer).map(({ text }) => text)).toEqual([
    '+',
  ]);
  const deep = { ...shallow, bottom: 120 };
  const placed = placeFragments(deep, { text: [], marks: [] }, layer);
  expect(placed.map(({ text }) => text)).toEqual([twoLine, '+']);
  for (const { text, x, y } of placed) {
    const band = footprint(text, x, y);
    expect(band.right).toBeLessThanOrEqual(deep.right + 6);
    expect(band.bottom).toBeLessThanOrEqual(deep.bottom + 6);
  }
});

test('a zone far down the page keeps every fragment inside the zone', () => {
  const below: Rect = { left: 100, top: 2000, right: 800, bottom: 2600 };
  const placed = placeFragments(below, { text: [], marks: [] }, lower(8152));
  expect(placed.length).toBe(2);
  for (const { text, x, y } of placed) {
    const band = footprint(text, x, y);
    expect(band.top).toBeGreaterThanOrEqual(below.top - 6);
    expect(band.bottom).toBeLessThanOrEqual(below.bottom + 6);
    expect(x).toBeGreaterThanOrEqual(below.left);
    expect(band.right).toBeLessThanOrEqual(below.right + 6);
  }
  const shallow = { ...below, bottom: below.top + 20 };
  expect(placeFragments(shallow, { text: [], marks: [] }, STRIP)).toEqual([]);
});

test('opacity within the layer range and seeds differ', () => {
  for (const { opacity } of placeFragments(zone, keepClear, lower(8152))) {
    expect(opacity).toBeGreaterThanOrEqual(0.16);
    expect(opacity).toBeLessThanOrEqual(0.28);
  }
  expect(placeFragments(zone, keepClear, lower(8152))).not.toEqual(
    placeFragments(zone, keepClear, lower(9400)),
  );
});
