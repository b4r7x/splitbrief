import { expect, test } from 'vitest';
import { poseAt } from './pose';
import { schedule } from './timeline';

const { cues, period } = schedule(
  { entry: 39, exit: 147, implementer: 222.8, reviewer: 331 },
  'wide',
);
const box = { left: 100, top: 100, width: 200, height: 250 };
const rest = { seen: undefined, box, period };
const landing = cues.implementer.at;

test('a seat braces its rim over the 0.6 s before the packet lands and settles after', () => {
  const cue = cues.implementer;
  expect(poseAt({ ...rest, cue, t: landing - 0.7 }).lift).toBe(0);
  expect(poseAt({ ...rest, cue, t: landing - 0.3 }).lift).toBeCloseTo(0.5);
  expect(poseAt({ ...rest, cue, t: landing }).lift).toBe(1);
  expect(poseAt({ ...rest, cue, t: landing + 0.25 }).lift).toBeCloseTo(0.5);
  expect(poseAt({ ...rest, cue, t: landing + 0.6 }).lift).toBe(0);
  expect(poseAt({ ...rest, cue: cues.planner, t: period - 0.3 }).lift).toBeCloseTo(0.5);
});

test('the implementer tears for 250 ms on landing and only the reviewer gains, across the loop seam', () => {
  const cue = cues.implementer;
  expect(poseAt({ ...rest, cue, t: landing }).jolt).toBe(true);
  expect(poseAt({ ...rest, cue, t: landing + 0.24 }).jolt).toBe(true);
  expect(poseAt({ ...rest, cue, t: landing + 0.26 }).jolt).toBe(false);
  expect(poseAt({ ...rest, cue, t: landing + 0.26 }).gain).toBe(1);
  const reviewer = cues.reviewer;
  expect(poseAt({ ...rest, cue: reviewer, t: reviewer.at + 0.2 }).gain).toBe(1.15);
  expect(poseAt({ ...rest, cue: reviewer, t: reviewer.at + 0.2 }).jolt).toBe(false);
  expect(poseAt({ ...rest, cue: reviewer, t: reviewer.at + 0.39 - period }).gain).toBe(1.15);
  expect(poseAt({ ...rest, cue: reviewer, t: reviewer.at + 0.41 - period }).gain).toBe(1);
});

test('the pupils point at the packet and rest when nothing is in flight', () => {
  const cue = cues.planner;
  expect(poseAt({ ...rest, cue, t: 5 }).gaze).toBeUndefined();
  expect(poseAt({ ...rest, cue, t: 5, seen: { x: 400, y: 200 } }).gaze).toEqual({ c: 1, r: 0 });
  expect(poseAt({ ...rest, cue, t: 5, seen: { x: 200, y: 500 } }).gaze).toEqual({ c: 0, r: 1 });
  expect(poseAt({ ...rest, cue, t: 5, seen: { x: 0, y: 0 } }).gaze).toEqual({ c: -1, r: -1 });
});
