import { describe, expect, it } from 'vitest';
import { detailPose } from './pose.js';

describe('detail poses', () => {
  it('splits the slash, unfolds briefs and reassembles the mark across the chapters', () => {
    expect(detailPose(0)).toEqual({ split: 0, briefs: 0 });
    expect(detailPose(0.15)).toEqual({ split: 1, briefs: 0 });
    expect(detailPose(0.49)).toEqual({ split: 0, briefs: 1 });
    expect(detailPose(0.82)).toEqual({ split: 0, briefs: 0 });
    expect(detailPose(1)).toEqual(detailPose(0.82));
  });

  it('keeps shape weights bounded throughout scrolling', () => {
    for (let step = 0; step <= 1000; step += 1) {
      const pose = detailPose(step / 1000);
      expect(Object.values(pose).every((value) => value >= 0 && value <= 1)).toBe(true);
      expect(pose.split + pose.briefs).toBeLessThanOrEqual(1);
    }
  });

  it('crosses key poses continuously and returns to the same pose when scrolling back', () => {
    for (const progress of [0.02, 0.14, 0.22, 0.44, 0.56, 0.79]) {
      const before = detailPose(progress - 0.0001);
      const after = detailPose(progress + 0.0001);
      expect(before.split).toBeCloseTo(after.split, 5);
      expect(before.briefs).toBeCloseTo(after.briefs, 5);
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
