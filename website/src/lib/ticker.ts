export type Ticker = {
  start(): void;
  stop(): void;
};

export function createTicker(target: Element, rate: number, onTick: (t: number) => void): Ticker {
  let frame: number | undefined;
  let origin: number | undefined;
  let tick = -1;
  let visible = true;
  let observer: IntersectionObserver | undefined;

  function loop(now: number): void {
    frame = requestAnimationFrame(loop);
    origin ??= now;
    const next = Math.floor(((now - origin) / 1000) * rate);
    if (next === tick) return;
    tick = next;
    onTick(tick / rate);
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
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) visible = entry.isIntersecting;
      if (visible) resume();
      else pause();
    });
    observer.observe(target);
    document.addEventListener('visibilitychange', onVisibility);
    resume();
  }

  function stop(): void {
    pause();
    observer?.disconnect();
    observer = undefined;
    document.removeEventListener('visibilitychange', onVisibility);
  }

  return { start, stop };
}
