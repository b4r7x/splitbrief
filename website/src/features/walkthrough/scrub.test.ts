import { describe, expect, it } from 'vitest';
import { createScrub } from './scrub.js';

describe('terminal scroll response', () => {
  it('softens a wheel step without overshoot and reaches its exact target within 120 ms', () => {
    const scrub = createScrub();
    scrub.set(1, 0);
    let previous = 0;
    for (let now = 0; now < 120; now += 8) {
      const value = scrub.read(now);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThan(1);
      previous = value;
    }
    expect(scrub.read(120)).toBe(1);
    expect(scrub.read(10_000)).toBe(1);
  });

  it('uses elapsed time at 60, 120 and 144 Hz, including a delayed frame', () => {
    const values = [60, 120, 144].map((hz) => {
      const scrub = createScrub();
      scrub.set(1, 0);
      for (let now = 0; now < 50; now += 1000 / hz) scrub.read(now);
      scrub.set(0.75, 50);
      for (let now = 50; now < 85; now += 1000 / hz) scrub.read(now);
      return [scrub.read(85), scrub.read(200)];
    });
    expect(values[0]).toEqual(values[1]);
    expect(values[1]).toEqual(values[2]);
    expect(values[0]?.[1]).toBe(0.75);
  });

  it('retargets from the current position and shortens the response on reversal', () => {
    const scrub = createScrub();
    scrub.set(1, 0);
    const before = scrub.read(40);
    scrub.set(0.2, 40);
    expect(scrub.read(40)).toBeCloseTo(before, 12);
    expect(scrub.read(48)).toBeLessThan(before);
    expect(scrub.read(99)).toBeGreaterThan(0.2);
    expect(scrub.read(100)).toBe(0.2);
  });

  it('only follows the latest input and never restarts for an unchanged scroll position', () => {
    const scrub = createScrub();
    for (let now = 0; now <= 200; now += 10) scrub.set(now / 1000, now);
    const before = scrub.read(210);
    scrub.set(0.2, 250);
    expect(scrub.read(250)).toBeGreaterThan(before);
    expect(scrub.read(320)).toBe(0.2);
  });

  it('drops pending motion for explicit navigation, layout changes and reduced motion', () => {
    const scrub = createScrub();
    scrub.set(0.8, 0);
    scrub.set(0.3, 20, true);
    expect(scrub.read(20)).toBe(0.3);
    expect(scrub.read(500)).toBe(0.3);
    scrub.set(0.4, 600);
    expect(scrub.read(600)).toBe(0.3);
    expect(scrub.read(720)).toBe(0.4);
  });
});
