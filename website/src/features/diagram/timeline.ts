import type { SeatName } from './seats';

export type Cue = {
  readonly at: number;
  readonly settle: number;
  readonly jolt: boolean;
  readonly gain: boolean;
};

export const PERIOD = 9;
export const LOOP: KeyframeAnimationOptions = {
  duration: PERIOD * 1000,
  iterations: Number.POSITIVE_INFINITY,
  fill: 'both',
};
export const CUES: Readonly<Record<SeatName, Cue>> = {
  planner: { at: 0, settle: 0.3, jolt: false, gain: false },
  implementer: { at: 3.4, settle: 0.5, jolt: true, gain: false },
  reviewer: { at: 7.4, settle: 0.6, jolt: false, gain: true },
};

export function frame(t: number, style: Keyframe): Keyframe {
  return { ...style, offset: t / PERIOD };
}

export function signed(offset: number): number {
  return ((((offset + PERIOD / 2) % PERIOD) + PERIOD) % PERIOD) - PERIOD / 2;
}
