import { SLOW_PROBE_AFTER_MS, slowProbeText } from '../core/discovery/probe-activity.js';
import type { ProbeActivity } from '../core/discovery/probe-activity.js';
import { probeActivitySnapshot, subscribeProbeActivity } from '../engine/probe-activity.js';

let holds = 0;

function checkKey(probe: ProbeActivity): string {
  return `${probe.tool}:${probe.check}`;
}

/**
 * Drops every line that comes due until the returned release runs: a screen or a prompt owns the
 * terminal then, and a raw line would break it.
 */
export function holdSlowProbeLines(): () => void {
  holds += 1;
  return () => {
    holds -= 1;
  };
}

/**
 * Writes `Checking tools · <tool> <check> 10s` once a probe has run `SLOW_PROBE_AFTER_MS`. Probes of
 * one tool and check that overlap give one line; a later probe of it gives its own line.
 */
export function watchSlowProbeLines(write: (line: string) => void): () => void {
  const timers = new Map<number, ReturnType<typeof setTimeout> | null>();
  const written = new Set<string>();

  const sync = (): void => {
    const probes = probeActivitySnapshot().probes;
    const running = new Set(probes.map((probe) => probe.id));
    const runningChecks = new Set(probes.map(checkKey));
    for (const [id, timer] of timers) {
      if (running.has(id)) continue;
      if (timer !== null) clearTimeout(timer);
      timers.delete(id);
    }
    for (const key of written) {
      if (!runningChecks.has(key)) written.delete(key);
    }
    for (const probe of probes) {
      if (timers.has(probe.id)) continue;
      const timer = setTimeout(
        () => {
          timers.set(probe.id, null);
          const key = checkKey(probe);
          if (written.has(key)) return;
          written.add(key);
          if (holds > 0) return;
          // A timer can fire a moment before the wall clock reaches its delay.
          const now = Math.max(Date.now(), probe.startedAt + SLOW_PROBE_AFTER_MS);
          const text = slowProbeText([probe], now);
          if (text !== null) write(`Checking tools · ${text}`);
        },
        SLOW_PROBE_AFTER_MS - (Date.now() - probe.startedAt),
      );
      timer.unref();
      timers.set(probe.id, timer);
    }
  };

  const unsubscribe = subscribeProbeActivity(sync);
  sync();
  return () => {
    unsubscribe();
    for (const timer of timers.values()) {
      if (timer !== null) clearTimeout(timer);
    }
    timers.clear();
  };
}
