import { hash } from '../../lib/noise';
import { prefersReducedMotion } from '../../lib/reduced-motion';
import { buildAtlas, colourFor, GLYPHS, glyphIndex } from './atlas';
import { density, glitchRow } from './density';
import { CELL_HEIGHT, CELL_WIDTH, type Seat } from './seats';

export type Ghost = {
  renderFrame(t: number): void;
  start(): void;
  stop(): void;
};

const SPARK_LAYER = -1;
const MAX_DPR = 2;

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('ghost canvas has no 2d context');
  return ctx;
}

export function createGhost({ canvas, seat }: { canvas: HTMLCanvasElement; seat: Seat }): Ghost {
  const dpr = Math.min(MAX_DPR, devicePixelRatio);
  const ctx = context2d(canvas);
  canvas.width = seat.cols * CELL_WIDTH * dpr;
  canvas.height = seat.rows * CELL_HEIGHT * dpr;
  canvas.style.width = `${seat.cols * CELL_WIDTH}px`;
  canvas.style.height = `${seat.rows * CELL_HEIGHT}px`;

  let atlas = buildAtlas(seat, dpr);
  let lastT: number | undefined;
  let frame: number | undefined;
  let origin: number | undefined;
  let tick = -1;
  let visible = true;
  let observer: IntersectionObserver | undefined;

  document.fonts.ready.then(() => {
    atlas = buildAtlas(seat, dpr);
    if (lastT !== undefined) renderFrame(lastT);
  });

  function renderFrame(t: number): void {
    lastT = t;
    const shifted = glitchRow(seat, t);
    const { image, tileWidth, tileHeight } = atlas;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let r = 0; r < seat.rows; r++) {
      const shift = r === shifted ? tileWidth : 0;
      for (let c = 0; c < seat.cols; c++) {
        const index = glyphIndex(density(seat, c, r, t));
        if (index === 0) continue;
        const spark = hash(seat.seed, c, r, SPARK_LAYER);
        const row = atlas.row(colourFor(seat, index / (GLYPHS.length - 1), spark).tint);
        ctx.drawImage(
          image,
          index * tileWidth,
          row * tileHeight,
          tileWidth,
          tileHeight,
          c * tileWidth + shift,
          r * tileHeight,
          tileWidth,
          tileHeight,
        );
      }
    }
  }

  function loop(now: number): void {
    frame = requestAnimationFrame(loop);
    origin ??= now;
    const next = Math.floor(((now - origin) / 1000) * seat.tickRate);
    if (next === tick) return;
    tick = next;
    renderFrame(tick / seat.tickRate);
  }

  function pause(): void {
    if (frame === undefined) return;
    cancelAnimationFrame(frame);
    frame = undefined;
  }

  function resume(): void {
    if (frame === undefined && visible && !document.hidden) frame = requestAnimationFrame(loop);
  }

  function onVisibility(): void {
    if (document.hidden) pause();
    else resume();
  }

  function start(): void {
    if (observer) return;
    if (prefersReducedMotion()) {
      renderFrame(0);
      return;
    }
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) visible = entry.isIntersecting;
      if (visible) resume();
      else pause();
    });
    observer.observe(canvas);
    document.addEventListener('visibilitychange', onVisibility);
    resume();
  }

  function stop(): void {
    pause();
    observer?.disconnect();
    observer = undefined;
    document.removeEventListener('visibilitychange', onVisibility);
  }

  return { renderFrame, start, stop };
}
