import type { Tier } from './scatter';
import type { SeatName } from './seats';

export type Cue = {
  readonly at: number;
  readonly settle: number;
  readonly jolt: boolean;
  readonly gain: boolean;
};

export type Distances = {
  readonly entry: number;
  readonly exit: number;
  readonly implementer: number;
  readonly reviewer: number;
};

export type Timeline = {
  readonly period: number;
  readonly handoff: number;
  readonly card: { readonly from: number; readonly to: number };
  readonly cues: Readonly<Record<SeatName, Cue>>;
  readonly loop: KeyframeAnimationOptions;
  frame(t: number, style: Keyframe): Keyframe;
};

const SPEED = 55;
const DWELL = 0.6;
const REST = 1.3;
// The review leg waits for the implementer's answer (a dwell covers its 0.55 s response); on the wide
// stage it leaves from the card, 200 px away from where the brief landed, so the eye gets a second dwell.
const HANDOFF: Readonly<Record<Tier, number>> = { wide: 2 * DWELL, compact: DWELL };

export function schedule(distances: Distances, tier: Tier): Timeline {
  const from = distances.entry / SPEED;
  const to = from + DWELL;
  const implementer = to + (distances.implementer - distances.exit) / SPEED;
  const handoff = HANDOFF[tier];
  const reviewer = implementer + handoff + distances.reviewer / SPEED;
  const period = reviewer + REST;
  return {
    period,
    handoff,
    card: { from, to },
    cues: {
      planner: { at: 0, settle: 0.3, jolt: false, gain: false },
      implementer: { at: implementer, settle: 0.5, jolt: true, gain: false },
      reviewer: { at: reviewer, settle: 0.6, jolt: false, gain: true },
    },
    loop: { duration: period * 1000, iterations: Number.POSITIVE_INFINITY, fill: 'both' },
    frame: (t, style) => ({ ...style, offset: t / period }),
  };
}
