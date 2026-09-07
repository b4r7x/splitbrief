import { find } from './find';
import { createGhost, type Ghost } from './ghost';
import { mountPackets } from './packet';
import { rainPhase, rainPoints } from './rain';
import {
  type GhostBox,
  type Rect,
  type ScatterPoint,
  scatterFragment,
  scatterPoints,
} from './scatter';
import { SEATS, type SeatName } from './seats';
import { createTicker } from './ticker';

export type Diagram = {
  start(): void;
  stop(): void;
};

const STAGE_WIDTH = 760;
const KEEP_CLEAR = '.tick, .label, .seat, .brief, .cross';
const RAINED = '.tick--planner, .tick--implementer';
const RAIN_RATE = 14;

function stageRect(stage: HTMLElement, element: Element): Rect {
  const outer = stage.getBoundingClientRect();
  const inner = element.getBoundingClientRect();
  const fit = outer.width / STAGE_WIDTH;
  return {
    left: (inner.left - outer.left) / fit,
    top: (inner.top - outer.top) / fit,
    width: inner.width / fit,
    height: inner.height / fit,
  };
}

function perSeat<T>(make: (name: SeatName) => T): Record<SeatName, T> {
  return { planner: make('planner'), implementer: make('implementer'), reviewer: make('reviewer') };
}

function layer(className: string, points: readonly ScatterPoint[]): HTMLElement {
  const element = document.createElement('span');
  element.className = className;
  element.setAttribute('aria-hidden', 'true');
  element.append(scatterFragment(points));
  return element;
}

export function mountDiagram(root: HTMLElement): Diagram {
  const stage = find<HTMLElement>(root, '.stage');
  new ResizeObserver((entries) => {
    for (const entry of entries) {
      root.style.setProperty('--fit', String(entry.contentRect.width / STAGE_WIDTH));
    }
  }).observe(root);
  const canvases = perSeat((name) => find<HTMLCanvasElement>(root, `.ghost--${name}`));
  const boxes: Record<SeatName, GhostBox> = perSeat((name) => ({
    seat: SEATS[name],
    ...stageRect(stage, canvases[name]),
  }));
  const packets = mountPackets(stage, boxes, stageRect(stage, find(root, '.brief')));
  const ghosts: Ghost[] = Object.values(
    perSeat((name) => {
      const ghost = createGhost({
        canvas: canvases[name],
        seat: SEATS[name],
        pose: () => packets.pose(name),
      });
      ghost.renderFrame(0);
      return ghost;
    }),
  );
  const exclusions = [...root.querySelectorAll(KEEP_CLEAR)].map((element) =>
    stageRect(stage, element),
  );
  const ticks = [...root.querySelectorAll(RAINED)].map((tick) => {
    const rect = stageRect(stage, tick);
    return rect.left + rect.width / 2;
  });
  const rain = layer('rain', rainPoints(ticks));
  stage.append(layer('scatter', scatterPoints({ ghosts: Object.values(boxes), exclusions })), rain);
  let shown = 0;
  const drift = createTicker(root, RAIN_RATE, (t) => {
    const { generation, offset } = rainPhase(t);
    if (generation !== shown) {
      shown = generation;
      rain.replaceChildren(scatterFragment(rainPoints(ticks, generation)));
    }
    rain.style.translate = `0 ${offset}px`;
  });

  return {
    start(): void {
      packets.start();
      drift.start();
      for (const ghost of ghosts) ghost.start();
    },
    stop(): void {
      packets.stop();
      drift.stop();
      for (const ghost of ghosts) {
        ghost.stop();
        ghost.renderFrame(0);
      }
    },
  };
}
