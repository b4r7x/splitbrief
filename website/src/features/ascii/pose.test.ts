import { describe, expect, it } from 'vitest';
import type { Part, Vector } from './geometry.js';
import { createPartTransform, detailPose } from './pose.js';

function transformPart(
  position: Vector,
  part: Part,
  pose: ReturnType<typeof detailPose>,
  entry: number,
): Vector {
  const result = { x: 0, z: 0 };
  createPartTransform(pose, entry)(position[0], position[2], part, result);
  return [result.x, position[1], result.z];
}

describe('detail poses', () => {
  it('opens the two brackets while leaving the slash in place for setup', () => {
    const pose = detailPose(0.16);
    expect(transformPart([-8, 2, 0], 'left', pose, 1)[0]).toBeCloseTo(-8.96);
    expect(transformPart([8, 2, 0], 'right', pose, 1)[0]).toBeCloseTo(8.96);
    expect(transformPart([2, 3, 0], 'slash', pose, 1)).toEqual([2, 3, 0]);
  });

  it('separates the record parts in depth, with no more than ten degrees of yaw', () => {
    const pose = detailPose(0.5);
    const left = transformPart([-8, 0, 0], 'left', pose, 1);
    const right = transformPart([8, 0, 0], 'right', pose, 1);
    expect(left[2]).not.toEqual(right[2]);
    expect(pose.yaw).toBeLessThanOrEqual(Math.PI / 18);
    expect(pose.depth).toBe(0.8);
    expect(pose.spread).toBe(0);
  });

  it('crosses key poses continuously and returns to the same pose when scrolling back', () => {
    for (const progress of [0.16, 0.5, 0.83]) {
      const before = transformPart([8, 2, 0.35], 'right', detailPose(progress - 0.0001), 1);
      const after = transformPart([8, 2, 0.35], 'right', detailPose(progress + 0.0001), 1);
      expect(
        Math.hypot(before[0] - after[0], before[1] - after[1], before[2] - after[2]),
      ).toBeLessThan(0.001);
    }
    const original = detailPose(0.39);
    detailPose(0.9);
    expect(detailPose(0.39)).toEqual(original);
  });

  it('uses a complete readable pose for each reduced-motion stage', () => {
    expect(detailPose(0.01, true)).toEqual(detailPose(0.32, true));
    expect(detailPose(0.34, true)).toEqual(detailPose(0.65, true));
    expect(detailPose(0.67, true)).toEqual(detailPose(1, true));
  });
});
