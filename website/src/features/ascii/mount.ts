import type { Scene } from '../../lib/scene.js';
import { mountAtmosphere } from './atmosphere.js';
import { buildPoints } from './geometry.js';
import { type ArtProgress, type ArtRegion, createRenderer } from './render.js';

type Options = {
  canvas: HTMLCanvasElement;
  atmosphere: HTMLElement;
  region: HTMLElement;
  progress: () => ArtProgress;
};

export function mountAscii({ canvas, atmosphere, region, progress }: Options): Scene {
  const unmountAtmosphere = mountAtmosphere(atmosphere);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    return { measure() {}, readScroll() {}, paint: () => false, destroy: unmountAtmosphere };
  }

  const renderer = createRenderer(context, buildPoints());
  let bounds: ArtRegion = { left: 0, top: 0, width: 0, height: 0 };
  let canvasLeft = 0;
  let canvasTop = 0;
  let canvasWidth = 0;
  let canvasHeight = 0;
  let last: ArtProgress = { workflow: -1, entry: -1, details: -1 };
  let lastTime = -1;
  let lastSnap = false;
  let dirty = true;
  let cleared = false;
  let disposed = false;

  function readScroll() {
    if (disposed) return;
    const rect = region.getBoundingClientRect();
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
      if (dirty || changed || (!frame.snap && frame.elapsedSeconds - lastTime >= 1 / 30)) {
        renderer.render(next, frame.elapsedSeconds, bounds, frame.snap);
        last = { ...next };
        lastTime = frame.elapsedSeconds;
        lastSnap = frame.snap;
        dirty = false;
        cleared = hidden;
      }
      return false;
    },
    destroy() {
      disposed = true;
      unmountAtmosphere();
    },
  };
}
