import { createGhost } from './ghost';
import { type GhostBox, type Rect, scatterFragment, scatterPoints } from './scatter';
import { SEATS } from './seats';

const STAGE_WIDTH = 760;
const KEEP_CLEAR = '.tick, .label, .seat, .brief, .cross';

function find<T extends Element>(root: HTMLElement, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`diagram has no ${selector}`);
  return element;
}

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

export function mountDiagram(root: HTMLElement): void {
  const stage = find<HTMLElement>(root, '.stage');
  new ResizeObserver((entries) => {
    for (const entry of entries) {
      root.style.setProperty('--fit', String(entry.contentRect.width / STAGE_WIDTH));
    }
  }).observe(root);
  const ghosts: GhostBox[] = Object.entries(SEATS).map(([name, seat]) => {
    const canvas = find<HTMLCanvasElement>(root, `.ghost--${name}`);
    createGhost({ canvas, seat }).renderFrame(0);
    const { left, top } = stageRect(stage, canvas);
    return { seat, left, top };
  });
  const exclusions = [...root.querySelectorAll(KEEP_CLEAR)].map((element) =>
    stageRect(stage, element),
  );
  const scatter = document.createElement('span');
  scatter.className = 'scatter';
  scatter.setAttribute('aria-hidden', 'true');
  scatter.append(scatterFragment(scatterPoints({ ghosts, exclusions })));
  stage.append(scatter);
}
