import { hash } from '../../lib/noise';
import { prefersReducedMotion } from '../../lib/reduced-motion';
import { buildAtlas, GLYPHS, glyphIndex, tintFor } from './atlas';
import { density, glitchRow, type Pose } from './density';
import { CELL_HEIGHT, CELL_WIDTH, type Seat } from './seats';
import { createTicker } from './ticker';

export type Ghost = {
  renderFrame(t: number, pose?: Pose): void;
  start(): void;
  stop(): void;
};

const SPARK_LAYER = -1;
const MAX_DPR = 2;
const REST: Pose = {};

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('ghost canvas has no 2d context');
  return ctx;
}

export function createGhost({
  canvas,
  seat,
  pose,
}: {
  canvas: HTMLCanvasElement;
  seat: Seat;
  pose?: () => Pose;
}): Ghost {
  const dpr = Math.min(MAX_DPR, devicePixelRatio);
  const ctx = context2d(canvas);
  canvas.width = seat.cols * CELL_WIDTH * dpr;
  canvas.height = seat.rows * CELL_HEIGHT * dpr;
  canvas.style.width = `${seat.cols * CELL_WIDTH}px`;
  canvas.style.height = `${seat.rows * CELL_HEIGHT}px`;

  let atlas = buildAtlas(seat, dpr);
  let lastT: number | undefined;
  const ticker = createTicker(canvas, seat.tickRate, (t) => renderFrame(t, pose?.()));

  document.fonts.ready.then(() => {
    atlas = buildAtlas(seat, dpr);
    if (lastT !== undefined) renderFrame(lastT);
  });

  function renderFrame(t: number, current: Pose = REST): void {
    lastT = t;
    const shifted = glitchRow(seat, t, current.jolt);
    const { image, tileWidth, tileHeight } = atlas;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let r = 0; r < seat.rows; r++) {
      const shift = r === shifted ? tileWidth : 0;
      for (let c = 0; c < seat.cols; c++) {
        const index = glyphIndex(density(seat, c, r, t, current));
        if (index === 0) continue;
        const spark = hash(seat.seed, c, r, SPARK_LAYER);
        const row = atlas.row(tintFor(seat, index / (GLYPHS.length - 1), spark));
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

  function start(): void {
    if (prefersReducedMotion()) {
      renderFrame(0);
      return;
    }
    ticker.start();
  }

  return { renderFrame, start, stop: ticker.stop };
}
