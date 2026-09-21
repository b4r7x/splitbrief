import { describe, expect, it } from 'vitest';
import { buildPoints } from './geometry.js';
import { markTargets } from './pose.js';

describe('bridge and mark correspondence', () => {
  const points = buildPoints();

  it('gives every sampled surface a finite start, destination, and semantic part', () => {
    expect(points.length).toBeGreaterThan(1000);
    expect(new Set(points.map((point) => point.part))).toEqual(new Set(['left', 'right', 'slash']));
    expect(points.every((point) => [...point.start, ...point.end].every(Number.isFinite))).toBe(
      true,
    );
    for (const part of ['left', 'right', 'slash']) {
      expect(points.filter((point) => point.part === part).length).toBeGreaterThan(100);
    }
    expect(
      points.every((point) => point.path >= 0 && point.path <= 1 && Number.isFinite(point.radial)),
    ).toBe(true);
  });

  it('preserves the open brackets as the center of the mark unfolds', () => {
    const first = points.find(
      (point) => point.part === 'left' && point.path === 0 && point.radial === 0,
    );
    const last = points.find(
      (point) => point.part === 'left' && point.path === 1 && point.radial === 0,
    );
    if (!first || !last) throw new Error('Missing bracket endpoints');
    expect(
      Math.hypot(...first.end.map((value, index) => value - (last.end[index] ?? 0))),
    ).toBeGreaterThan(10);
    for (const target of ['split', 'briefs'] as const) {
      const start = markTargets(first)[target];
      const end = markTargets(last)[target];
      expect(start[0]).toBe(end[0]);
      expect(start[2]).toBe(end[2]);
      expect(end[1] - start[1]).toBeGreaterThan(8);
    }
  });

  it('unfolds the slash into three separated brief sheets', () => {
    const depths = new Set(
      points
        .filter((point) => point.part === 'slash')
        .map((point) => Math.round(markTargets(point).briefs[2] / 1.2)),
    );
    expect(depths).toEqual(new Set([-1, 0, 1]));
  });

  it('keeps every target finite and inside the artwork envelope', () => {
    const samples = points.filter((_, index) => index % 97 === 0);
    expect(
      samples.every((point) =>
        Object.values(markTargets(point))
          .flat()
          .every((value) => Number.isFinite(value) && Math.abs(value) < 11),
      ),
    ).toBe(true);
  });
});
