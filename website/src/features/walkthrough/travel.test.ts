import { describe, expect, it } from 'vitest';
import { advanceTravel } from './travel.js';

describe('document travel', () => {
  it('accelerates from rest, decelerates, and settles exactly without overshooting', () => {
    let current = { offset: 0, velocity: 0 };
    const steps: number[] = [];
    for (let frame = 0; frame < 120; frame += 1) {
      const next = advanceTravel(current, 500, 1000 / 60);
      expect(next.offset).toBeGreaterThanOrEqual(current.offset);
      expect(next.offset).toBeLessThanOrEqual(500);
      steps.push(next.offset - current.offset);
      current = next;
    }
    expect(steps[0]).toBeLessThan(steps[1] ?? 0);
    expect(Math.max(...steps)).toBeLessThan(40);
    expect(current).toEqual({ offset: 500, velocity: 0 });
  });

  it('covers the same distance at different frame rates', () => {
    const position = (hz: number) => {
      let current = { offset: 0, velocity: 0 };
      for (let frame = 0; frame < hz / 2; frame += 1) {
        current = advanceTravel(current, 500, 1000 / hz);
      }
      return current;
    };
    for (const hz of [30, 60, 120, 144]) {
      expect(position(hz).offset).toBeCloseTo(position(60).offset, 8);
      expect(position(hz).velocity).toBeCloseTo(position(60).velocity, 8);
    }
  });

  it('brakes before reversing when the scroll target changes', () => {
    let current = advanceTravel({ offset: 0, velocity: 0 }, 500, 100);
    const reversing = advanceTravel(current, 0, 1);
    expect(reversing.velocity).toBeGreaterThan(0);
    expect(reversing.velocity).toBeLessThan(current.velocity);
    current = reversing;
    for (let frame = 0; frame < 120; frame += 1) {
      current = advanceTravel(current, 0, 1000 / 60);
      expect(current.offset).toBeGreaterThanOrEqual(0);
      expect(current.offset).toBeLessThan(500);
    }
    expect(current).toEqual({ offset: 0, velocity: 0 });
  });
});
