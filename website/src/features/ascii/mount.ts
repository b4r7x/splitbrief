import type { Scene } from '../../lib/scene.js';
import { mountAtmosphere } from './atmosphere.js';
import { buildPoints } from './geometry.js';
import { type ArtProgress, type ArtRegion, createRenderer } from './render.js';

type Options = {
  canvas: HTMLCanvasElement;
  atmosphere: HTMLElement;
  region: HTMLElement;
  footerRegion?: HTMLElement;
  progress: () => ArtProgress;
};

export function mountAscii({ canvas, atmosphere, region, footerRegion, progress }: Options): Scene {
  const background = mountAtmosphere(atmosphere);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    return { measure() {}, readScroll() {}, paint: () => false, destroy: background.destroy };
  }

  const renderer = createRenderer(context, buildPoints());
  let bounds: ArtRegion = { left: 0, top: 0, width: 0, height: 0 };
  let canvasLeft = 0;
  let canvasTop = 0;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let last: ArtProgress = { workflow: -1, entry: -1, details: -1 };
  let lastSnap = false;
  let dirty = true;
  let cleared = false;
  let disposed = false;
  let reveal = 1;

  function readScroll() {
    if (disposed) return;
    let rect = region.getBoundingClientRect();
    let nextReveal = 1;
    if (footerRegion && (rect.width <= 16 || rect.height <= 16)) {
      const footer = footerRegion.getBoundingClientRect();
      if (footer.top < canvasTop + canvasHeight && footer.bottom > canvasTop) {
        rect = footer;
        const divider = footerRegion.parentElement?.getBoundingClientRect();
        if (divider)
          nextReveal = Math.max(
            0,
            Math.min(1, (canvasTop + canvasHeight - divider.top) / Math.min(divider.height, 100)),
          );
      }
    }
    if (nextReveal !== reveal) dirty = true;
    reveal = nextReveal;
    const next = {
      left: rect.left - canvasLeft,
      top: rect.top - canvasTop,
      width: rect.width,
      height: rect.height,
    };
    if (
      next.left !== bounds.left ||
      next.top !== bounds.top ||
      next.width !== bounds.width ||
      next.height !== bounds.height
    )
      dirty = true;
    bounds = next;
  }

  function measure() {
    if (disposed) return;
    const rect = canvas.getBoundingClientRect();
    canvasLeft = rect.left;
    canvasTop = rect.top;
    canvasWidth = rect.width;
    canvasHeight = rect.height;
    renderer.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
    readScroll();
    dirty = true;
    cleared = false;
  }

  return {
    measure,
    readScroll,
    paint(frame) {
      if (disposed) return false;
      const next = progress();
      background.paint(1 - (1 - next.workflow) ** 2);
      const hidden =
        next.entry === 1 &&
        (bounds.top + bounds.height <= 0 ||
          bounds.top >= canvasHeight ||
          bounds.left + bounds.width <= 0 ||
          bounds.left >= canvasWidth ||
          bounds.width <= 16 ||
          bounds.height <= 16);
      if (hidden && cleared) return false;
      const changed =
        next.workflow !== last.workflow ||
        next.entry !== last.entry ||
        next.details !== last.details ||
        frame.snap !== lastSnap;
      if (dirty || changed) {
        renderer.render(next, bounds, frame.snap, frame.snap && reveal > 0 ? 1 : reveal);
        last = { ...next };
        lastSnap = frame.snap;
        dirty = false;
        cleared = hidden;
      }
      return false;
    },
    destroy() {
      disposed = true;
      background.destroy();
    },
  };
}
