import type { Point, Vector } from './geometry.js';

type Pose = { split: number; briefs: number };
type Targets = { split: Vector; briefs: Vector };

const smooth = (value: number) => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

export function detailPose(progress: number, snap = false): Pose {
  if (snap) {
    return {
      split: progress < 1 / 3 ? 1 : 0,
      briefs: progress >= 1 / 3 && progress < 2 / 3 ? 1 : 0,
    };
  }
  const unfold = smooth((progress - 0.22) / 0.22);
  const reassemble = smooth((progress - 0.56) / 0.23);
  return {
    split: smooth((progress - 0.02) / 0.12) * (1 - unfold),
    briefs: unfold * (1 - reassemble),
  };
}

export function markTargets({ end, path, radial, part, glyph }: Point): Targets {
  if (part !== 'slash') {
    const side = part === 'left' ? -1 : 1;
    return {
      split: [end[0] + side * 1.3, end[1] * 0.84, end[2]],
      briefs: [end[0] + side * 1.6, end[1], end[2]],
    };
  }
  const branch = Math.cos(radial) < 0 ? -1 : 1;
  const turn = (((radial / (Math.PI * 2)) % 1) + 1) % 1;
  const sheet = Math.min(2, Math.floor(turn * 3)) - 1;
  const edge = Math.min(4, Math.floor(path * 5));
  const along = path * 5 - edge;
  let x = -3.3;
  let y = -3.7;
  if (edge === 0) x += along * 6.6;
  else if (edge === 1) {
    x = 3.3;
    y += along * 5.5;
  } else if (edge === 2) {
    x = 3.3 - along * 1.9;
    y = 1.8 + along * 1.9;
  } else if (edge === 3) {
    x = 1.4 - along * 4.7;
    y = 3.7;
  } else y = 3.7 - along * 7.4;

  if (sheet < 1) {
    if (path < 0.52) {
      x = -3.3;
      y = 3.7 - (path / 0.52) * 7.4;
    } else {
      x = -3.3 + ((path - 0.52) / 0.48) * 6.6;
      y = -3.7;
    }
  } else if (glyph === '=') {
    const line = Math.min(2, Math.floor(path * 3));
    x = -2.1 + (path * 3 - line) * (line === 2 ? 2.8 : 4.2);
    y = 1.7 - line * 1.6;
  }
  return {
    split: [end[0] * 0.58 + branch * 2.1, end[1] * 0.84, end[2] * 0.7],
    briefs: [
      x + sheet * 1.1 + Math.cos(radial * 3) * 0.18,
      y + sheet * 1.1,
      sheet * 1.2 + Math.sin(radial * 3) * 0.18,
    ],
  };
}
