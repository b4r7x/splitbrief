import type { Scene } from './scene.js';

export function createMotion() {
  let scenes: readonly Scene[] = [];
  let buttons: readonly HTMLButtonElement[] = [];
  let disposers: Array<() => void> = [];
  let frame = 0;
  let previousTime: number | undefined;
  let elapsedSeconds = 0;
  let needsRead = true;
  let needsMeasure = true;
  let paused = false;
  let reduced = false;
  let active = false;
  let generation = 0;

  function schedule() {
    if (active && !frame && !document.hidden) frame = requestAnimationFrame(tick);
  }

  function invalidate() {
    needsRead = true;
    schedule();
  }

  function measure() {
    needsMeasure = true;
    invalidate();
  }

  function tick(now: number) {
    frame = 0;
    const deltaMs = previousTime === undefined ? 16 : Math.min(48, now - previousTime);
    previousTime = now;
    if (!paused && !reduced) elapsedSeconds += deltaMs / 1000;
    if (needsMeasure) {
      needsMeasure = false;
      for (const scene of scenes) scene.measure();
    }
    if (needsRead) {
      needsRead = false;
      for (const scene of scenes) scene.readScroll();
    }
    let settling = false;
    for (const scene of scenes) {
      settling = scene.paint({ deltaMs, elapsedSeconds, snap: reduced }) || settling;
    }
    if (settling || needsRead || (!paused && !reduced)) schedule();
  }

  function updateButtons() {
    updateBackground();
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(paused || reduced));
      button.disabled = reduced;
      button.textContent = reduced ? 'Motion reduced' : paused ? 'Resume motion' : 'Pause motion';
    }
  }

  function updateBackground() {
    document.documentElement.toggleAttribute(
      'data-motion-paused',
      paused || reduced || document.hidden,
    );
  }

  function stop() {
    generation += 1;
    active = false;
    cancelAnimationFrame(frame);
    frame = 0;
    previousTime = undefined;
    for (const dispose of disposers) dispose();
    disposers = [];
    for (const scene of scenes) scene.destroy();
    scenes = [];
    buttons = [];
    document.documentElement.removeAttribute('data-motion-paused');
  }

  function start(nextScenes: readonly Scene[], pauseButtons: readonly HTMLButtonElement[]) {
    if (
      active &&
      nextScenes.length === scenes.length &&
      nextScenes.every((scene, index) => scene === scenes[index])
    ) {
      measure();
      return;
    }
    stop();
    scenes = nextScenes;
    buttons = pauseButtons;
    active = true;
    paused = false;
    elapsedSeconds = 0;
    const currentGeneration = generation;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    reduced = media.matches;

    const onPause = () => {
      paused = !paused;
      updateButtons();
      invalidate();
    };
    const onReduced = () => {
      reduced = media.matches;
      updateButtons();
      measure();
    };
    const onVisibility = () => {
      previousTime = undefined;
      updateBackground();
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else invalidate();
    };
    window.addEventListener('scroll', invalidate, { passive: true });
    window.addEventListener('resize', measure, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    media.addEventListener('change', onReduced);
    disposers.push(
      () => window.removeEventListener('scroll', invalidate),
      () => window.removeEventListener('resize', measure),
      () => document.removeEventListener('visibilitychange', onVisibility),
      () => media.removeEventListener('change', onReduced),
    );
    for (const button of buttons) {
      button.addEventListener('click', onPause);
      disposers.push(() => button.removeEventListener('click', onPause));
    }
    void document.fonts.ready.then(() => {
      if (active && generation === currentGeneration) measure();
    });
    updateButtons();
    measure();
  }

  return { invalidate, start, destroy: stop };
}
