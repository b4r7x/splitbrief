import { expect, test } from 'vitest';
import { isTrace, placeFragments, type Rect, travelBand } from './place';
import { BRIEFS, GUTTER_GLYPHS, HERO, POOL, VALIDATION } from './pool';

const viewport = { width: 1440, height: 900 };
const nav: Rect = { left: 0, top: 0, right: 1440, bottom: 96 };
const headline = domRect({ left: 64, top: 285, right: 600, bottom: 700 });
const lede: Rect = { left: 64, top: 716, right: 608, bottom: 790 };
const cta: Rect = { left: 64, top: 820, right: 348, bottom: 866 };
const planner: Rect = { left: 632, top: 320, right: 842, bottom: 596 };
const keepClear = { text: [headline, lede, cta], marks: [nav, planner], panels: [] };
const exclusions = [...keepClear.text, ...keepClear.marks];
const PIN = [
  ['brief -> implementer', 911, 222],
  ['typecheck · lint · test', 897, 429],
  ['retry(3) -> escalate', 911, 635],
  ['const brief = compile(spec)', 879, 841],
  ['while (red) retry()', 440, 177],
  ['promote(diff)', 1207, 437],
  ['evidence.jsonl', 1201, 643],
  ['real software', 1207, 849],
  ['lower spend', 1219, 231],
  ['fewer blind spots', 1018, 311],
  ['one file per brief', 1013, 517],
  ['0x2f 0x62 0x72', 1034, 723],
  ['[ 3 / 7 ]', 1334, 167],
  ['∴', 1386, 373],
  ['//', 1379, 579],
  ['→', 1386, 786],
  ['T1 ✓', 79, 181],
  ['T2 ▸', 883, 311],
  ['hash ok', 871, 517],
  ['worktree', 867, 724],
];

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
  const placed = placeFragments(viewport, keepClear, HERO);
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
  const none = { text: [], marks: [], panels: [] };
  expect(placeFragments(viewport, keepClear, HERO)).toEqual(
    placeFragments(viewport, keepClear, HERO),
  );
  expect(placeFragments(viewport, { text: [headline], marks: [], panels: [] }, HERO)).not.toEqual(
    placeFragments(viewport, keepClear, HERO),
  );
  expect(placeFragments({ width: 390, height: 844 }, none, HERO)).not.toEqual(
    placeFragments(viewport, none, HERO),
  );
});

test('the hero layer places the recorded origins', () => {
  expect(
    placeFragments(viewport, keepClear, HERO).map(({ text, x, y }) => [
      text,
      Math.round(x),
      Math.round(y),
    ]),
  ).toEqual(PIN);
});

test('a string never reads as a tail of a text line', () => {
  const layer = {
    pool: ['attempt 2/3', '· · · · · · · · 47s', '∴'],
    seed: 8091,
    opacity: { min: 0.16, max: 0.28 },
    lineGap: 96,
    gutterGlyphs: [],
    glyphHeight: 16,
    textGap: { x: 24, y: 24 },
  };
  const line = { left: 400, top: 300, right: 700, bottom: 320 };
  const placed = placeFragments(viewport, { text: [line], marks: [], panels: [] }, layer);
  for (const { text, x, y } of placed) {
    if (text.length <= 1) continue;
    const band = travelBand(text, x, y);
    if (!(band.top < 328 && band.bottom > 292)) continue;
    const width = text.length * 6.6;
    if (isTrace(text)) expect(x >= 892 || x + width <= 208).toBe(true);
    else expect(x >= 796 || x + width <= 304).toBe(true);
  }
});

test('gutter glyphs', () => {
  const layer = {
    pool: ['first failure'],
    seed: 8091,
    opacity: { min: 0.16, max: 0.28 },
    lineGap: 96,
    gutterGlyphs: GUTTER_GLYPHS,
    glyphHeight: 16,
    textGap: { x: 24, y: 24 },
  };
  const none = { text: [], marks: [], panels: [] };
  const placed = placeFragments(viewport, none, layer);
  const gutters = placed.slice(1);
  expect(gutters.length).toBeLessThanOrEqual(4);
  for (const { text, x, y } of gutters) {
    expect(GUTTER_GLYPHS).toContain(text);
    expect(Math.abs(x - 24) < 0.01 || Math.abs(x - (1440 - 24 - 6.6)) < 0.01).toBe(true);
    expect(y).toBeGreaterThanOrEqual(88);
    expect(y).toBeLessThanOrEqual(900 - 24 - 11);
  }
  placed.forEach((a, i) => {
    for (const b of placed.slice(i + 1)) {
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(60);
    }
  });
  expect(placeFragments(viewport, none, { ...layer, gutterGlyphs: [] })).toHaveLength(1);
});

test('opacity within the layer range and seeds differ', () => {
  for (const { opacity } of placeFragments(viewport, keepClear, BRIEFS)) {
    expect(opacity).toBeGreaterThanOrEqual(0.16);
    expect(opacity).toBeLessThanOrEqual(0.28);
  }
  expect(placeFragments(viewport, keepClear, BRIEFS)).not.toEqual(
    placeFragments(viewport, keepClear, VALIDATION),
  );
});
