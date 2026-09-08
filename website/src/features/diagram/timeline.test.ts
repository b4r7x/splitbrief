import { expect, test } from 'vitest';
import { schedule } from './timeline';

const wide = { entry: 39, exit: 147, implementer: 222.8, reviewer: 331 };
const compact = { entry: 53.7, exit: 157.7, implementer: 213.2, reviewer: 65.5 };

test('every visible leg runs at 55 px/s, the card holds the packet 0.6 s, and the loop rests 1.3 s', () => {
  const { card, cues, handoff, period, loop, frame } = schedule(wide, 'wide');
  expect(handoff).toBe(0);
  expect(card.from).toBeCloseTo(0.709);
  expect(card.to).toBeCloseTo(1.309);
  expect(cues.implementer.at).toBeCloseTo(2.687);
  expect(cues.reviewer.at).toBeCloseTo(8.705);
  expect(period).toBeCloseTo(10.005);
  expect(loop).toEqual({
    duration: period * 1000,
    iterations: Number.POSITIVE_INFINITY,
    fill: 'both',
  });
  expect(frame(period / 2, { opacity: 1 })).toEqual({ opacity: 1, offset: 0.5 });
  expect(cues.planner).toEqual({ at: 0, settle: 0.3, jolt: false, gain: false });
  expect(cues.implementer.jolt).toBe(true);
  expect(cues.reviewer.gain).toBe(true);
});

test('the compact stage holds the brief in the implementer for a dwell before the reviewer leg', () => {
  const { cues, handoff, period } = schedule(compact, 'compact');
  expect(handoff).toBe(0.6);
  expect(cues.implementer.at).toBeCloseTo(2.585);
  expect(cues.reviewer.at).toBeCloseTo(4.376);
  expect(period).toBeCloseTo(5.676);
});
