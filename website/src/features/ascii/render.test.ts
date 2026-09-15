import { describe, expect, it } from 'vitest';
import type { Point, Vector } from './geometry.js';
import { createRenderer } from './render.js';

function point(end: Vector, glyph: string, tone: number): Point {
  return { start: end, end, part: 'slash', tone, glyph, edge: false, phase: 0 };
}

function canvas() {
  const draws: Array<{ glyph: string; x: number; y: number; color: string }> = [];
  const context = {
    canvas: { width: 0, height: 0 },
    fillStyle: '',
    setTransform() {},
    fillRect() {},
    fillText(glyph: string, x: number, y: number) {
      draws.push({ glyph, x, y, color: this.fillStyle });
    },
  };
  return { draws, context: context as unknown as CanvasRenderingContext2D };
}

const progress = { workflow: 1, entry: 1, details: 0.83 };
const region = { left: 0, top: 0, width: 700, height: 500 };

describe('ASCII raster output', () => {
  it('paints the final depth winner once per cell, including later equal-depth points', () => {
    const { context, draws } = canvas();
    const renderer = createRenderer(context, [
      point([0, 0, 0.01], 'H', 4),
      point([0, 0, 0], ':', 1),
      point([1, 0, 0], '+', 2),
      point([1, 0, 0], '=', 5),
    ]);
    renderer.resize(700, 500, 1);
    renderer.render({ ...progress, workflow: 0, entry: 0 }, 0, region, true);
    expect(draws.map(({ glyph }) => glyph)).toEqual(['H', '=']);
  });

  it('preserves palette order and row-major order within a tone', () => {
    const { context, draws } = canvas();
    const renderer = createRenderer(context, [
      point([1, 0, 0], 'R', 1),
      point([0, 0, 0], 'M', 6),
      point([-1, 0, 0], 'L', 1),
      point([0, 1, 0], 'T', 1),
    ]);
    renderer.resize(700, 500, 1);
    renderer.render(progress, 0, region, true);
    expect(draws.map(({ glyph }) => glyph)).toEqual(['T', 'L', 'R', 'M']);
    expect(draws.map(({ color }) => color)).toEqual(['#3c3c3c', '#3c3c3c', '#3c3c3c', '#767676']);
  });

  it('does not retain occupied cells when the region hides or the canvas resizes', () => {
    const { context, draws } = canvas();
    const renderer = createRenderer(context, [point([0, 0, 0], '#', 3)]);
    renderer.resize(700, 500, 1);
    renderer.render(progress, 0, region, true);
    expect(draws).toHaveLength(1);
    draws.length = 0;
    renderer.render(progress, 0, { ...region, top: 500 }, true);
    expect(draws).toHaveLength(0);
    renderer.resize(350, 250, 2);
    renderer.render(progress, 0, { ...region, width: 350, height: 250 }, true);
    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ x: 175, y: 130 });
  });
});
