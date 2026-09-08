import { find } from './find';
import { createGhost, type Ghost } from './ghost';
import { mountPackets, type Packets } from './packet';
import { rainPhase, rainPoints } from './rain';
import {
  type GhostBox,
  type Rect,
  type ScatterPoint,
  scatterFragment,
  scatterPoints,
  type Tier,
} from './scatter';
import { SEATS, type SeatName } from './seats';
import { createTicker } from './ticker';

export type Diagram = {
  start(): void;
  stop(): void;
};

type Scene = {
  readonly width: number;
  readonly packets: Packets;
  start(): void;
  stop(): void;
  remove(): void;
};

const KEEP_CLEAR = '.tick, .label, .seat, .brief, .cross';
const RAINED = '.tick--planner, .tick--implementer';
const RAIN_RATE = 14;

function stageRect(stage: HTMLElement, element: Element): Rect {
  const outer = stage.getBoundingClientRect();
  const inner = element.getBoundingClientRect();
  const fit = outer.width / stage.offsetWidth;
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

function visibleRoutes(stage: HTMLElement): SVGSVGElement {
  const routes = [...stage.querySelectorAll<SVGSVGElement>('.route-lines')].find((svg) =>
    svg.checkVisibility(),
  );
  if (!routes) throw new Error('diagram has no visible routes');
  return routes;
}

function buildScene(
  root: HTMLElement,
  stage: HTMLElement,
  canvases: Readonly<Record<SeatName, HTMLCanvasElement>>,
): Scene {
  const routes = visibleRoutes(stage);
  const compact = routes.classList.contains('route-lines--compact');
  const tier: Tier = compact ? 'compact' : 'wide';
  const boxes: Record<SeatName, GhostBox> = perSeat((name) => ({
    seat: SEATS[name],
    ...stageRect(stage, canvases[name]),
  }));
  const packets = mountPackets(stage, routes, boxes, tier);
  const exclusions = [...root.querySelectorAll(KEEP_CLEAR)].map((element) =>
    stageRect(stage, element),
  );
  const rained = compact
    ? []
    : [...root.querySelectorAll(RAINED)].map((tick) => {
        const rect = stageRect(stage, tick);
        return rect.left + rect.width / 2;
      });
  const scatter = layer(
    'scatter',
    scatterPoints({ ghosts: Object.values(boxes), exclusions, tier }),
  );
  const rain = layer('rain', rainPoints(rained));
  stage.append(scatter, rain);
  let shown = 0;
  const drift = createTicker(root, RAIN_RATE, (t) => {
    const { generation, offset } = rainPhase(t);
    if (generation !== shown) {
      shown = generation;
      rain.replaceChildren(scatterFragment(rainPoints(rained, generation)));
    }
    rain.style.translate = `0 ${offset}px`;
  });
  return {
    width: stage.offsetWidth,
    packets,
    start(): void {
      packets.start();
      if (rained.length > 0) drift.start();
    },
    stop(): void {
      packets.stop();
      drift.stop();
    },
    remove(): void {
      scatter.remove();
      rain.remove();
    },
  };
}

export function mountDiagram(root: HTMLElement): Diagram {
  const stage = find<HTMLElement>(root, '.stage');
  const canvases = perSeat((name) => find<HTMLCanvasElement>(root, `.ghost--${name}`));
  let running = false;
  let scene = buildScene(root, stage, canvases);
  const ghosts: Ghost[] = Object.values(
    perSeat((name) => {
      const ghost = createGhost({
        canvas: canvases[name],
        seat: SEATS[name],
        pose: () => scene.packets.pose(name),
      });
      ghost.renderFrame(0);
      return ghost;
    }),
  );
  new ResizeObserver((entries) => {
    for (const entry of entries) {
      const fit = Math.min(1, entry.contentRect.width / stage.offsetWidth);
      root.style.setProperty('--fit', String(fit));
    }
    if (scene.width === stage.offsetWidth) return;
    scene.stop();
    scene.remove();
    scene = buildScene(root, stage, canvases);
    if (running) scene.start();
  }).observe(root);

  return {
    start(): void {
      running = true;
      scene.start();
      for (const ghost of ghosts) ghost.start();
    },
    stop(): void {
      running = false;
      scene.stop();
      for (const ghost of ghosts) {
        ghost.stop();
        ghost.renderFrame(0);
      }
    },
  };
}
