import { type KeepClear, type Layer, type Placement, placeFragments } from './place';

export type Fragments = {
  start(): void;
  stop(): void;
};

export type { KeepClear, Rect } from './place';

const PHONE = 768;
const TRAVEL = 64;
const FADE = { in: 1, out: 2 };

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

export function mountFragments(
  layer: HTMLElement,
  keepClear: () => KeepClear,
  spec: Layer,
): Fragments {
  let hovering: { span: HTMLElement; placement: Placement }[] = [];
  let running = false;

  function place(): void {
    hovering = (
      innerWidth < PHONE
        ? []
        : placeFragments(
            { width: layer.clientWidth, height: layer.clientHeight },
            keepClear(),
            spec,
          )
    ).map((placement) => {
      const span = document.createElement('span');
      span.className = 'fragment';
      span.textContent = placement.text;
      span.style.left = `${placement.x}px`;
      span.style.top = `${placement.y}px`;
      span.style.opacity = String(placement.opacity);
      return { span, placement };
    });
    for (const span of layer.querySelectorAll(':scope > .fragment')) span.remove();
    for (const { span } of hovering) layer.append(span);
    if (!running) return;
    layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 480, easing: 'ease-out' });
    for (const { span, placement } of hovering) hover(span, placement);
  }

  let queued = 0;
  document.fonts.ready.then(place);
  addEventListener('resize', () => {
    cancelAnimationFrame(queued);
    queued = requestAnimationFrame(place);
  });

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
