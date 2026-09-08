import type { Pose } from './density';
import { find } from './find';
import { poseAt } from './pose';
import { reactions } from './response';
import {
  extend,
  length,
  offsetPath,
  type Point,
  type Polyline,
  parsePath,
  pointAt,
} from './route-geometry';
import { type GhostBox, ghostRect, type Rect, type Tier } from './scatter';
import type { SeatName } from './seats';
import { schedule, type Timeline } from './timeline';

export type Packets = {
  pose(name: SeatName): Pose;
  start(): void;
  stop(): void;
};

type Leg = { readonly until: number; readonly distance: number };
type Route = { readonly from: number; readonly via: readonly Leg[]; readonly end: Leg };

const INSET = 8;
const FADE = 0.12;
const REST: Pose = {};
const WAKE = [
  { size: 5, lag: 0.12, opacity: 0.45 },
  { size: 4, lag: 0.24, opacity: 0.3 },
  { size: 3, lag: 0.36, opacity: 0.15 },
];

function drawn(routes: Element, name: string): Polyline {
  return parsePath(find<SVGPathElement>(routes, `.route--${name}`).getAttribute('d') ?? '');
}

function ride(timeline: Timeline, route: Route, opacity: number): Keyframe[] {
  const { frame, period } = timeline;
  const legs = [...route.via, route.end];
  return [
    frame(0, { offsetDistance: '0px', opacity: 0 }),
    frame(route.from, { offsetDistance: '0px', opacity: 0 }),
    frame(route.from + FADE, { opacity }),
    ...legs.map((leg) => frame(leg.until, { offsetDistance: `${leg.distance}px`, opacity })),
    frame(route.end.until + FADE, { opacity: 0 }),
    frame(period, { offsetDistance: `${route.end.distance}px`, opacity: 0 }),
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
  routes: Element,
  ghosts: Readonly<Record<SeatName, GhostBox>>,
  tier: Tier,
): Packets {
  const boxes: Record<SeatName, Rect> = {
    planner: ghostRect(ghosts.planner),
    implementer: ghostRect(ghosts.implementer),
    reviewer: ghostRect(ghosts.reviewer),
  };
  for (const stale of stage.querySelectorAll('.wake')) stale.remove();
  const a = drawn(routes, 'a');
  const b = drawn(routes, 'b');
  const ab: Polyline = [a[0], ...a.slice(1), ...b];
  const implPath = extend(ab, INSET);
  const revPath = extend(drawn(routes, 'c'), INSET);
  const entry = INSET + length(a);
  const exit = entry + length(ab) - length(a) - length(b);
  const timeline = schedule(
    { entry, exit, implementer: length(implPath), reviewer: length(revPath) },
    tier,
  );
  const { card, cues, handoff, period } = timeline;
  const impl: Route = {
    from: 0,
    via: [
      { until: card.from, distance: entry },
      { until: card.to, distance: exit },
    ],
    end: { until: cues.implementer.at, distance: length(implPath) },
  };
  const rev: Route = {
    from: cues.implementer.at + handoff,
    via: [],
    end: { until: cues.reviewer.at, distance: length(revPath) },
  };
  const riders = [
    { element: find<HTMLElement>(stage, '.packet--impl'), path: implPath, route: impl },
    { element: find<HTMLElement>(stage, '.packet--rev'), path: revPath, route: rev },
  ].flatMap(({ element, path, route }) => {
    const css = offsetPath(path);
    element.style.setProperty('offset-path', css);
    return [
      { element, frames: ride(timeline, route, 1), delay: 0 },
      ...WAKE.map((trail) => ({
        element: wake(element, css, trail.size),
        frames: ride(timeline, route, trail.opacity),
        delay: trail.lag * 1000,
      })),
    ];
  });
  const answers = reactions(stage, timeline);
  let animations: Animation[] = [];
  let clock: Animation | undefined;

  function time(): number {
    const now = clock?.currentTime;
    return typeof now === 'number' ? (now / 1000) % period : 0;
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
    return poseAt({ cue: cues[name], t, period, box: boxes[name], seen: target(t) });
  }

  function start(): void {
    if (clock) return;
    animations = [...riders, ...answers].map(({ element, frames, delay }) =>
      element.animate(frames, { ...timeline.loop, delay }),
    );
    clock = animations[0];
  }

  function stop(): void {
    for (const animation of animations) animation.cancel();
    animations = [];
    clock = undefined;
  }

  return { pose, start, stop };
}
