import { useEffect, useState } from 'react';

type TickListener = (now: number) => void;

const listeners = new Set<TickListener>();
let interval: ReturnType<typeof setInterval> | null = null;

function publish(): void {
  const now = Date.now();
  for (const listener of listeners) listener(now);
}

function start(): void {
  if (interval !== null) return;
  interval = setInterval(publish, 1000);
  interval.unref?.();
}

function stop(): void {
  if (interval === null) return;
  clearInterval(interval);
  interval = null;
}

function subscribe(listener: TickListener): () => void {
  listeners.add(listener);
  // A joining surface moves every surface on the clock to the same sample, so the header and the
  // sidebar can never read different seconds for the same run.
  publish();
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/**
 * The one ticking clock for every surface that states elapsed run time. One shared interval feeds
 * every subscriber the same `now`, so no two surfaces can sample a different second; a surface
 * that stops asking (a frozen clock) takes itself off the clock and the last sample stays.
 */
export function useSharedClock(input: { active: boolean }): number {
  const { active } = input;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    return subscribe(setNow);
  }, [active]);
  return now;
}
