import { expect, test } from 'vitest';
import { type GhostBox, type Rect, scatterPoints } from './scatter';
import { CELL_HEIGHT, CELL_WIDTH } from './seats';
import { SEATS } from './seats';
import { inside } from './silhouette';

const ghosts: GhostBox[] = [
  { seat: SEATS.planner, left: 1.4, top: 206.5 },
  { seat: SEATS.implementer, left: 418.2, top: 214.4 },
  { seat: SEATS.reviewer, left: 439.8, top: 520.2 },
];
const plannerLabel: Rect = { left: 106.4, top: 154.8, width: 96, height: 40 };
const card: Rect = { left: 254.4, top: 343.6, width: 84, height: 104 };
const field = { ghosts, exclusions: [plannerLabel, card] };

const BAND = { x0: 0, y0: 51.6, x1: 182.4, y1: 223.6, spread: 24 };
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
  expect(points.length).toBeGreaterThanOrEqual(80);
  expect(points.length).toBeLessThanOrEqual(100);
  for (const point of points) expect('.:·').toContain(point.glyph);
});

test('no glyph lands inside a ghost, on the planner label, or on the card', () => {
  for (const { x, y } of scatterPoints(field)) {
    for (const box of ghosts) expect(inGhost(box, x, y), `${x},${y}`).toBe(false);
    expect(inRect(plannerLabel, x, y), `${x},${y}`).toBe(false);
    expect(inRect(card, x, y), `${x},${y}`).toBe(false);
  }
});

test('every glyph sits in the diagonal band or within 30px of a ghost rim', () => {
  const points = scatterPoints(field);
  for (const { x, y } of points) {
    expect(inBand(x, y) || ghosts.some((box) => nearGhost(box, x, y)), `${x},${y}`).toBe(true);
  }
  expect(points.filter(({ x, y }) => inBand(x, y)).length).toBeGreaterThanOrEqual(50);
  for (const box of ghosts) {
    expect(points.filter(({ x, y }) => nearGhost(box, x, y)).length).toBeGreaterThanOrEqual(10);
  }
});
