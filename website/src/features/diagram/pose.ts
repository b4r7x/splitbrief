import type { Pose } from './density';
import type { Point } from './route-geometry';
import type { Rect } from './scatter';
import type { Cell } from './seats';
import { type Cue, signed } from './timeline';

const BRACE = 0.6;
const LANDING = 0.4;
const LANDING_GAIN = 1.15;
const EYE_ROW = 0.4;
const LEVEL = { across: 0.25, down: 0.4 };

function gazeAt(box: Rect, seen: Point): Cell {
  const eyeX = box.left + box.width / 2;
  const eyeY = box.top + EYE_ROW * box.height;
  const dx = LEVEL.across * box.width;
  const dy = LEVEL.down * box.height;
  return {
    c: seen.x < eyeX - dx ? -1 : seen.x > eyeX + dx ? 1 : 0,
    r: seen.y < eyeY - dy ? -1 : seen.y > eyeY + dy ? 1 : 0,
  };
}

export function poseAt({
  cue,
  t,
  box,
  seen,
  glitchMs,
}: {
  cue: Cue;
  t: number;
  box: Rect;
  seen: Point | undefined;
  glitchMs: number;
}): Pose {
  const d = signed(t - cue.at);
  const lift = d < 0 ? Math.max(0, 1 + d / BRACE) : Math.max(0, 1 - d / cue.settle);
  return {
    ...(seen && { gaze: gazeAt(box, seen) }),
    lift,
    gain: cue.gain && d >= 0 && d < LANDING ? LANDING_GAIN : 1,
    jolt: cue.jolt && d >= 0 && d < glitchMs / 1000,
  };
}
