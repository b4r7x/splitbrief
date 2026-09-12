import { find } from './find';
import type { SeatName } from './seats';
import type { Timeline } from './timeline';

export type Reaction = {
  readonly element: Element;
  readonly frames: Keyframe[];
  readonly delay: number;
};

const RISE = 0.05;
const HOLD = 0.4;
const FALL = 0.1;
const LAG = 0.15;
const LANDINGS: readonly SeatName[] = ['implementer', 'reviewer'];

export function reactions(stage: HTMLElement, timeline: Timeline): Reaction[] {
  const { card, cues, period, frame } = timeline;
  const style = getComputedStyle(document.documentElement);
  const token = (name: string): string => style.getPropertyValue(name).trim();
  const hair = token('--hair-strong');
  const ink2 = token('--ink-2');
  const ink3 = token('--ink-3');
  const spark = token('--white-spark');
  const held = card.to - card.from;
  const flash = (prop: 'color' | 'backgroundColor', rest: string, lit: string): Keyframe[] => [
    frame(0, { [prop]: rest }),
    frame(RISE, { [prop]: lit }),
    frame(HOLD, { [prop]: lit }),
    frame(HOLD + FALL, { [prop]: rest }),
    frame(period, { [prop]: rest }),
  ];
  return [
    {
      element: find(stage, '.brief'),
      delay: card.from * 1000,
      frames: [
        frame(0, { borderColor: hair }),
        frame(FALL, { borderColor: spark }),
        frame(held, { borderColor: spark }),
        frame(held + FALL, { borderColor: hair }),
        frame(period, { borderColor: hair }),
      ],
    },
    ...LANDINGS.flatMap((name) => {
      const delay = cues[name].at * 1000;
      return [
        {
          element: find(stage, `.tick--${name}`),
          delay,
          frames: flash('backgroundColor', ink3, spark),
        },
        {
          element: find(stage, `.seat--${name}`),
          delay: delay + LAG * 1000,
          frames: flash('color', ink3, ink2),
        },
      ];
    }),
  ];
}
