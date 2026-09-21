import { describe, expect, it } from 'vitest';
import type { Point, Vector } from './geometry.js';
import { buildPoints } from './geometry.js';
import { createRenderer } from './render.js';

function point(end: Vector, glyph: string, tone: number): Point {
  return { start: end, end, part: 'slash', tone, glyph, edge: false, phase: 0, path: 0, radial: 0 };
}

function canvas() {
  const draws: Array<{ glyph: string; x: number; y: number; color: string }> = [];
  function surface() {
    const marks: typeof draws = [];
    let ratio = 1;
    const brush = {
      fillStyle: '',
      setTransform(scale: number) {
        ratio = scale;
      },
      fillText(glyph: string, x: number, y: number) {
        marks.push({ glyph, x: x * ratio, y: y * ratio, color: this.fillStyle });
      },
    };
    return { marks, width: 0, height: 0, getContext: () => brush };
  }
  const context = {
    canvas: { width: 0, height: 0, ownerDocument: { createElement: surface } },
    fillStyle: '',
    setTransform() {},
    fillRect() {},
    drawImage(
      image: ReturnType<typeof surface>,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      x: number,
      y: number,
      width: number,
      height: number,
    ) {
      for (const mark of image.marks) {
        if (mark.x >= sx && mark.x < sx + sw && mark.y >= sy && mark.y < sy + sh) {
          draws.push({
            glyph: mark.glyph,
            color: mark.color,
            x: x + ((mark.x - sx) / sw) * width,
            y: y + ((mark.y - sy) / sh) * height,
          });
        }
      }
    },
  };
  return { draws, context: context as unknown as CanvasRenderingContext2D };
}

const progress = { workflow: 1, entry: 1, details: 0.83 };
const region = { left: 0, top: 0, width: 700, height: 500 };

describe('ASCII raster output', () => {
  it('visibly reshapes the mark between chapters and restores the same pixels on return', () => {
    const { context, draws } = canvas();
    const renderer = createRenderer(context, buildPoints());
    renderer.resize(700, 500, 1);
    const poses = [0.15, 0.49, 0.82, 0.15].map((details) => {
      draws.length = 0;
      renderer.render({ ...progress, details }, region, false);
      return [...draws];
    });
    const before = new Set(poses[0]?.map(({ x, y }) => `${x},${y}`));
    for (const pose of poses.slice(1, 3)) {
      const after = new Set(pose.map(({ x, y }) => `${x},${y}`));
      const added = [...after].filter((cell) => !before.has(cell)).length;
      const removed = [...before].filter((cell) => !after.has(cell)).length;
      expect((added + removed) / (before.size + added)).toBeGreaterThan(0.25);
    }
    expect(poses[3]).toEqual(poses[0]);
  });

  it('paints identical glyphs and lighting when progress stays fixed', () => {
    const { context, draws } = canvas();
    const renderer = createRenderer(context, buildPoints());
    renderer.resize(700, 500, 1);
    for (const snap of [false, true]) {
      draws.length = 0;
      renderer.render(progress, region, snap);
      const before = [...draws];
      draws.length = 0;
      renderer.render(progress, region, snap);
      expect(draws).toEqual(before);
    }
  });

  it('paints the final depth winner once per cell, including later equal-depth points', () => {
    const { context, draws } = canvas();
    const renderer = createRenderer(context, [
      point([0, 0, 0.01], 'H', 4),
      point([0, 0, 0], ':', 1),
      point([1, 0, 0], '+', 2),
      point([1, 0, 0], '=', 5),
    ]);
    renderer.resize(700, 500, 1);
    renderer.render({ ...progress, workflow: 0, entry: 0 }, region, true);
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
    renderer.render(progress, region, true);
    expect(draws.map(({ glyph }) => glyph)).toEqual(['T', 'L', 'R', 'M']);
    expect(draws.map(({ color }) => color)).toEqual(['#3c3c3c', '#3c3c3c', '#3c3c3c', '#767676']);
  });

  it('does not retain occupied cells when the region hides or the canvas resizes', () => {
    const { context, draws } = canvas();
    const renderer = createRenderer(context, [point([0, 0, 0], '#', 3)]);
    renderer.resize(700, 500, 1);
    renderer.render(progress, region, true);
    expect(draws).toHaveLength(1);
    draws.length = 0;
    renderer.render(progress, { ...region, top: 500 }, true);
    expect(draws).toHaveLength(0);
    renderer.resize(350, 250, 2);
    renderer.render(progress, { ...region, width: 350, height: 250 }, true);
    expect(draws).toHaveLength(1);
    expect(draws[0]).toMatchObject({ x: 175, y: 130 });
  });
});
