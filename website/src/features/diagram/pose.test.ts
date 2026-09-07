import { expect, test } from 'vitest';
import { poseAt } from './pose';
import { CUES } from './timeline';

const box = { left: 100, top: 100, width: 200, height: 250 };
const rest = { seen: undefined, glitchMs: 90, box };

test('a seat braces its rim over the 0.6 s before the packet lands and settles after', () => {
  const cue = CUES.implementer;
  expect(poseAt({ ...rest, cue, t: 2.5 }).lift).toBe(0);
  expect(poseAt({ ...rest, cue, t: 3.1 }).lift).toBeCloseTo(0.5);
  expect(poseAt({ ...rest, cue, t: 3.4 }).lift).toBe(1);
  expect(poseAt({ ...rest, cue, t: 3.65 }).lift).toBeCloseTo(0.5);
  expect(poseAt({ ...rest, cue, t: 4 }).lift).toBe(0);
  expect(poseAt({ ...rest, cue: CUES.planner, t: 8.7 }).lift).toBeCloseTo(0.5);
});

test('only the implementer jolts on landing and only the reviewer gains', () => {
  expect(poseAt({ ...rest, cue: CUES.implementer, t: 3.44 }).jolt).toBe(true);
  expect(poseAt({ ...rest, cue: CUES.implementer, t: 3.5 }).jolt).toBe(false);
  expect(poseAt({ ...rest, cue: CUES.implementer, t: 3.5 }).gain).toBe(1);
  expect(poseAt({ ...rest, cue: CUES.reviewer, t: 7.6 }).gain).toBe(1.15);
  expect(poseAt({ ...rest, cue: CUES.reviewer, t: 7.6 }).jolt).toBe(false);
  expect(poseAt({ ...rest, cue: CUES.reviewer, t: 7.9 }).gain).toBe(1);
});

test('the pupils point at the packet and rest when nothing is in flight', () => {
  const cue = CUES.planner;
  expect(poseAt({ ...rest, cue, t: 5 }).gaze).toBeUndefined();
  expect(poseAt({ ...rest, cue, t: 5, seen: { x: 400, y: 200 } }).gaze).toEqual({ c: 1, r: 0 });
  expect(poseAt({ ...rest, cue, t: 5, seen: { x: 200, y: 500 } }).gaze).toEqual({ c: 0, r: 1 });
  expect(poseAt({ ...rest, cue, t: 5, seen: { x: 0, y: 0 } }).gaze).toEqual({ c: -1, r: -1 });
});
