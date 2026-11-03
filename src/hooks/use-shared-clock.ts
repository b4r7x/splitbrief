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
  // A joining surface moves every surface on the clock to the same sample, so two surfaces can
  // never read different seconds.
  publish();
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

/**
 * The one ticking clock for every surface that states a freshness or a session's age. One
 * shared interval feeds every subscriber the same `now`, so no two surfaces can sample a different
 * second. A surface asks for the clock as a rule of its sample, so the frame that takes it off the
 * clock reads the same sample as the rule did, and that sample stays.
 */
export function useSharedClock(input: { active: (now: number) => boolean }): number {
  const [now, setNow] = useState(() => Date.now());
  const active = input.active(now);
  useEffect(() => {
    if (!active) return;
    return subscribe(setNow);
  }, [active]);
  return now;
}
