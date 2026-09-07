import type { Pose } from './density';
import { find } from './find';
import { poseAt } from './pose';
import { responses } from './response';
import { length, offsetPath, type Point, type Polyline, pointAt } from './route-geometry';
import { type GhostBox, ghostRect, type Rect } from './scatter';
import type { SeatName } from './seats';
import { CUES, frame, LOOP, PERIOD } from './timeline';

export type Packets = {
  pose(name: SeatName): Pose;
  start(): void;
  stop(): void;
};

type Leg = { readonly until: number; readonly distance: number };
type Route = { readonly from: number; readonly via: readonly Leg[]; readonly end: Leg };

const STAGE = { width: 760, height: 860 };
const INSET = 8;
const FADE = 0.12;
const REST: Pose = {};
const WAKE = [
  { size: 5, lag: 0.12, opacity: 0.45 },
  { size: 4, lag: 0.24, opacity: 0.3 },
  { size: 3, lag: 0.36, opacity: 0.15 },
];

function ride(route: Route, opacity: number): Keyframe[] {
  const legs = [...route.via, route.end];
  return [
    frame(0, { offsetDistance: '0px', opacity: 0 }),
    frame(route.from, { offsetDistance: '0px', opacity: 0 }),
    frame(route.from + FADE, { opacity }),
    ...legs.map((leg) => frame(leg.until, { offsetDistance: `${leg.distance}px`, opacity })),
    frame(route.end.until + FADE, { opacity: 0 }),
    frame(PERIOD, { offsetDistance: `${route.end.distance}px`, opacity: 0 }),
  ];
}

function distanceAt(route: Route, t: number): number | undefined {
  if (t < route.from || t >= route.end.until + FADE) return undefined;
  let from = route.from;
  let start = 0;
  for (const leg of [...route.via, route.end]) {
    if (t <= leg.until) return start + ((t - from) / (leg.until - from)) * (leg.distance - start);
    from = leg.until;
    start = leg.distance;
  }
  return route.end.distance;
}

function wake(packet: HTMLElement, path: string, size: number): HTMLElement {
  const trail = document.createElement('span');
  trail.className = 'wake';
  trail.style.setProperty('offset-path', path);
  trail.style.width = `${size}px`;
  trail.style.height = `${size}px`;
  packet.before(trail);
  return trail;
}

export function mountPackets(
  stage: HTMLElement,
  ghosts: Readonly<Record<SeatName, GhostBox>>,
  card: Rect,
): Packets {
  const boxes: Record<SeatName, Rect> = {
    planner: ghostRect(ghosts.planner),
    implementer: ghostRect(ghosts.implementer),
    reviewer: ghostRect(ghosts.reviewer),
  };
  const y = card.top + card.height / 2;
  const implPath: Polyline = [
    { x: boxes.planner.left + boxes.planner.width - INSET, y },
    { x: boxes.implementer.left + INSET, y },
  ];
  const cardX = card.left + card.width / 2;
  const revPath: Polyline = [
    { x: cardX, y: card.top + card.height - INSET },
    { x: cardX, y: STAGE.height * 0.6 },
    { x: STAGE.width * 0.49, y: STAGE.height * 0.6 },
    { x: STAGE.width * 0.49, y: STAGE.height * 0.72 },
    { x: boxes.reviewer.left + INSET, y: STAGE.height * 0.72 },
  ];
  const impl: Route = {
    from: 0,
    via: [
      { until: 1.2, distance: card.left - implPath[0].x },
      { until: 1.8, distance: card.left + card.width - implPath[0].x },
    ],
    end: { until: 3.4, distance: length(implPath) },
  };
  const rev: Route = { from: 3.4, via: [], end: { until: 7.4, distance: length(revPath) } };
  const riders = [
    { element: find<HTMLElement>(stage, '.packet--impl'), path: implPath, route: impl },
    { element: find<HTMLElement>(stage, '.packet--rev'), path: revPath, route: rev },
  ].flatMap(({ element, path, route }) => {
    const css = offsetPath(path);
    element.style.setProperty('offset-path', css);
    return [
      { element, frames: ride(route, 1), delay: 0 },
      ...WAKE.map((trail) => ({
        element: wake(element, css, trail.size),
        frames: ride(route, trail.opacity),
        delay: trail.lag * 1000,
      })),
    ];
  });
  const cues = responses(stage);
  let animations: Animation[] = [];
  let clock: Animation | undefined;

  function time(): number {
    const now = clock?.currentTime;
    return typeof now === 'number' ? (now / 1000) % PERIOD : 0;
  }

  function target(t: number): Point | undefined {
    const onRev = distanceAt(rev, t);
    if (onRev !== undefined) return pointAt(revPath, onRev);
    const onImpl = distanceAt(impl, t);
    return onImpl === undefined ? undefined : pointAt(implPath, onImpl);
  }

  function pose(name: SeatName): Pose {
    if (!clock) return REST;
    const t = time();
    return poseAt({
      cue: CUES[name],
      t,
      box: boxes[name],
      seen: target(t),
      glitchMs: ghosts[name].seat.glitchMs,
    });
  }

  function start(): void {
    if (clock) return;
    animations = [
      ...riders.map(({ element, frames, delay }) => element.animate(frames, { ...LOOP, delay })),
      ...cues.map(({ element, frames }) => element.animate(frames, LOOP)),
    ];
    clock = animations[0];
  }

  function stop(): void {
    for (const animation of animations) animation.cancel();
    animations = [];
    clock = undefined;
  }

  return { pose, start, stop };
}
