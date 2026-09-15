import { describe, expect, it } from 'vitest';
import { buildPoints } from './geometry.js';
import { createPartTransform, detailPose } from './pose.js';

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
  });

  it('preserves all point destinations when the install mark reassembles', () => {
    const transform = createPartTransform(detailPose(0.83), 1);
    const position = { x: 0, z: 0 };
    expect(
      points.every((point) => {
        transform(point.end[0], point.end[2], point.part, position);
        return position.x === point.end[0] && position.z === point.end[2];
      }),
    ).toBe(true);
  });

  it('keeps the original bridge untouched before entry into the details scene', () => {
    const transform = createPartTransform(detailPose(0.5), 0);
    const position = { x: 0, z: 0 };
    expect(
      points.every((point) => {
        transform(point.start[0], point.start[2], point.part, position);
        return position.x === point.start[0] && position.z === point.start[2];
      }),
    ).toBe(true);
  });

  it('keeps each point finite across both directions of the detail transformation', () => {
    const samples = points.filter((_, index) => index % 97 === 0);
    const progress = [0, 0.16, 0.32, 0.5, 0.66, 0.83, 1, 0.5, 0];
    expect(
      progress.every((value) => {
        const transform = createPartTransform(detailPose(value), 1);
        const position = { x: 0, z: 0 };
        return samples.every((point) => {
          transform(point.end[0], point.end[2], point.part, position);
          return Number.isFinite(position.x) && Number.isFinite(position.z);
        });
      }),
    ).toBe(true);
  });
});
