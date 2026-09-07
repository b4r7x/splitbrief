import { expect, test } from 'vitest';
import { type GhostBox, type Rect, scatterPoints } from './scatter';
import { CELL_HEIGHT, CELL_WIDTH, SEATS } from './seats';
import { inside } from './silhouette';

const ghosts: GhostBox[] = [
  { seat: SEATS.planner, left: 1.4, top: 206.5 },
  { seat: SEATS.implementer, left: 418.2, top: 214.4 },
  { seat: SEATS.reviewer, left: 439.8, top: 520.2 },
];
const plannerLabel: Rect = { left: 106.4, top: 154.8, width: 96, height: 40 };
const card: Rect = { left: 254.4, top: 343.6, width: 84, height: 104 };
const planSeat: Rect = { left: 45.6, top: 516, width: 64, height: 84 };
const cross: Rect = { left: 221, top: 595, width: 14, height: 14 };
const field = { ghosts, exclusions: [plannerLabel, card, planSeat, cross] };

const BAND = { x0: 0, y0: 51.6, x1: 182.4, y1: 223.6, spread: 24 };
const TRAIL: Rect = { left: 0, top: 516, width: 296.4, height: 344 };
const REACH = 30;

function inGhost(box: GhostBox, x: number, y: number): boolean {
  const width = box.seat.cols * CELL_WIDTH;
  const height = box.seat.rows * CELL_HEIGHT;
  return inside((x - box.left) / width, (y - box.top) / height);
}

function inRect(rect: Rect, x: number, y: number): boolean {
  return x > rect.left && x < rect.left + rect.width && y > rect.top && y < rect.top + rect.height;
}

function inBand(x: number, y: number): boolean {
  const dx = BAND.x1 - BAND.x0;
  const dy = BAND.y1 - BAND.y0;
  const length = Math.hypot(dx, dy);
  const along = ((x - BAND.x0) * dx + (y - BAND.y0) * dy) / length;
  const across = Math.abs((x - BAND.x0) * dy - (y - BAND.y0) * dx) / length;
  return along >= 0 && along <= length && across <= BAND.spread;
}

function nearGhost(box: GhostBox, x: number, y: number): boolean {
  const width = box.seat.cols * CELL_WIDTH;
  const height = box.seat.rows * CELL_HEIGHT;
  return (
    x >= box.left - REACH &&
    x <= box.left + width + REACH &&
    y >= box.top - REACH &&
    y <= box.top + height + REACH
  );
}

test('the same field scatters the same glyphs every time', () => {
  const points = scatterPoints(field);
  expect(points).toEqual(scatterPoints(field));
  expect(points.length).toBeGreaterThanOrEqual(110);
  expect(points.length).toBeLessThanOrEqual(130);
  for (const point of points) expect('.:·').toContain(point.glyph);
});

test('no glyph lands inside a ghost or on the labels, card, and crosshair it must clear', () => {
  for (const { x, y } of scatterPoints(field)) {
    for (const box of ghosts) expect(inGhost(box, x, y), `${x},${y}`).toBe(false);
    for (const rect of field.exclusions) expect(inRect(rect, x, y), `${x},${y}`).toBe(false);
  }
});

test('every glyph sits in the diagonal band, the lower-left trail, or a ghost halo', () => {
  const points = scatterPoints(field);
  for (const { x, y } of points) {
    const placed =
      inBand(x, y) || inRect(TRAIL, x, y) || ghosts.some((box) => nearGhost(box, x, y));
    expect(placed, `${x},${y}`).toBe(true);
  }
  expect(points.filter(({ x, y }) => inBand(x, y)).length).toBeGreaterThanOrEqual(50);
  for (const box of ghosts) {
    expect(points.filter(({ x, y }) => nearGhost(box, x, y)).length).toBeGreaterThanOrEqual(10);
  }
});

test('the lower-left trail is lighter than the band and uses only . and :', () => {
  const points = scatterPoints(field);
  const trail = points.filter(({ x, y }) => inRect(TRAIL, x, y));
  const band = points.filter(({ x, y }) => inBand(x, y));
  expect(trail.length).toBeGreaterThanOrEqual(20);
  expect(trail.length).toBeLessThanOrEqual(30);
  for (const point of trail) expect('.:').toContain(point.glyph);
  const perPixel = (count: number, area: number): number => count / area;
  expect(perPixel(trail.length, TRAIL.width * TRAIL.height)).toBeLessThan(
    perPixel(band.length, 48 * Math.hypot(182.4, 172)) / 4,
  );
});
