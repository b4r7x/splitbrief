import { hash } from '../../lib/noise';
import { POOL } from './pool';

export type Rect = {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

export type Viewport = { readonly width: number; readonly height: number };

export type Placement = {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly duration: number;
  readonly opacity: number;
  readonly phase: number;
};

export type Fragments = {
  start(): void;
  stop(): void;
};

const SEED = 23;
const COUNT = 28;
const TRIES = 2000;
const TRAVEL = 120;
const MARGIN = 6;
const GLYPH = { width: 6.6, height: 11 };
const DURATION = { min: 14, max: 28 };
const OPACITY = { min: 0.18, max: 0.35 };
const FADE = { in: 1, out: 2 };

export function travelBand(text: string, x: number, y: number): Rect {
  return {
    left: x - MARGIN,
    top: y - TRAVEL - MARGIN,
    right: x + text.length * GLYPH.width + MARGIN,
    bottom: y + GLYPH.height + MARGIN,
  };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function placeFragments(viewport: Viewport, exclusions: readonly Rect[]): Placement[] {
  const placed: Placement[] = [];
  const taken: Rect[] = [...exclusions];
  let k = 0;
  for (const text of [...POOL, ...POOL].slice(0, COUNT)) {
    for (let tries = 0; tries < TRIES; tries++, k++) {
      const width = text.length * GLYPH.width;
      const x = MARGIN + hash(SEED, k, 0, 0) * (viewport.width - width - 2 * MARGIN);
      const y = hash(SEED, k, 1, 0) * (viewport.height + TRAVEL - GLYPH.height);
      const band = travelBand(text, x, y);
      if (taken.some((rect) => overlaps(rect, band))) continue;
      taken.push(band);
      placed.push({
        text,
        x,
        y,
        duration: DURATION.min + hash(SEED, k, 2, 0) * (DURATION.max - DURATION.min),
        opacity: OPACITY.min + hash(SEED, k, 3, 0) * (OPACITY.max - OPACITY.min),
        phase: hash(SEED, k, 4, 0),
      });
      break;
    }
  }
  return placed;
}

function hover(span: HTMLElement, placement: Placement): Animation {
  const { duration, opacity, phase } = placement;
  return span.animate(
    [
      { translate: '0 0', opacity: 0, offset: 0 },
      { opacity, offset: FADE.in / duration },
      { opacity, offset: 1 - FADE.out / duration },
      { translate: `0 ${-TRAVEL}px`, opacity: 0, offset: 1 },
    ],
    {
      duration: duration * 1000,
      delay: -phase * duration * 1000,
      iterations: Number.POSITIVE_INFINITY,
    },
  );
}

export function mountFragments(layer: HTMLElement, exclusions: () => readonly Rect[]): Fragments {
  let hovering: { span: HTMLElement; placement: Placement }[] = [];
  let running = false;

  function place(): void {
    hovering = placeFragments({ width: innerWidth, height: innerHeight }, exclusions()).map(
      (placement) => {
        const span = document.createElement('span');
        span.className = 'fragment';
        span.textContent = placement.text;
        span.style.left = `${placement.x}px`;
        span.style.top = `${placement.y}px`;
        span.style.opacity = String(placement.opacity);
        return { span, placement };
      },
    );
    layer.replaceChildren(...hovering.map(({ span }) => span));
    if (!running) return;
    layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 480, easing: 'ease-out' });
    for (const { span, placement } of hovering) hover(span, placement);
  }

  document.fonts.ready.then(place);
  addEventListener('resize', place);

  return {
    start(): void {
      if (running) return;
      running = true;
      for (const { span, placement } of hovering) hover(span, placement);
    },
    stop(): void {
      running = false;
      for (const { span } of hovering)
        for (const animation of span.getAnimations()) animation.cancel();
    },
  };
}
