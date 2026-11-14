import type { IdleTimers, SpawnIdleOptions } from './types.js';

export function clearIdleTimers(timers: IdleTimers): void {
  if (timers.warn !== undefined) clearTimeout(timers.warn);
  if (timers.kill !== undefined) clearTimeout(timers.kill);
  timers.warn = undefined;
  timers.kill = undefined;
}

export function armIdleTimers(
  timers: IdleTimers,
  idle: SpawnIdleOptions,
  warn: (silentMs: number) => void,
  kill: (killMs: number) => void,
): void {
  clearIdleTimers(timers);
  const since = Date.now();
  timers.warn = setTimeout(() => {
    timers.warned = true;
    if (idle.onWarn !== undefined) {
      // Node starts the timer from the cached loop time, which can be older than `since`, and
      // the wall clock can run behind the monotonic one, so the reading may be under warnMs.
      warn(Math.max(idle.warnMs, Date.now() - since));
    }
  }, idle.warnMs);
  timers.warn.unref?.();
  const killMs = idle.killMs;
  if (killMs === undefined) return;
  timers.kill = setTimeout(() => kill(killMs), killMs);
  timers.kill.unref?.();
}
