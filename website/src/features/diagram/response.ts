import { find } from './find';
import type { SeatName } from './seats';
import { CUES, frame, PERIOD } from './timeline';

export type Response = { readonly element: Element; readonly frames: Keyframe[] };

const RISE = 0.05;
const HOLD = 0.4;
const FALL = 0.1;
const DWELL = { from: 1.2, to: 1.8 };
const LANDINGS: readonly SeatName[] = ['implementer', 'reviewer'];

function flash(
  prop: 'color' | 'backgroundColor',
  rest: string,
  lit: string,
  at: number,
): Keyframe[] {
  return [
    frame(0, { [prop]: rest }),
    frame(at, { [prop]: rest }),
    frame(at + RISE, { [prop]: lit }),
    frame(at + HOLD, { [prop]: lit }),
    frame(at + HOLD + FALL, { [prop]: rest }),
    frame(PERIOD, { [prop]: rest }),
  ];
}

export function responses(stage: HTMLElement): Response[] {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string): string => style.getPropertyValue(name).trim();
  const hair = token('--hair-strong');
  const ink2 = token('--ink-2');
  const ink3 = token('--ink-3');
  const spark = token('--white-spark');
  return [
    {
      element: find(stage, '.brief'),
      frames: [
        frame(0, { borderColor: hair }),
        frame(DWELL.from, { borderColor: hair }),
        frame(DWELL.from + FALL, { borderColor: spark }),
        frame(DWELL.to, { borderColor: spark }),
        frame(DWELL.to + FALL, { borderColor: hair }),
        frame(PERIOD, { borderColor: hair }),
      ],
    },
    ...LANDINGS.flatMap((name) => [
      {
        element: find(stage, `.tick--${name}`),
        frames: flash('backgroundColor', ink3, spark, CUES[name].at),
      },
      { element: find(stage, `.seat--${name}`), frames: flash('color', ink3, ink2, CUES[name].at) },
    ]),
  ];
}
