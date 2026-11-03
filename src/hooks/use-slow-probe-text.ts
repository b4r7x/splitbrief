import { useSyncExternalStore } from 'react';
import { type ProbeActivitySnapshot, slowProbeText } from '../core/discovery/probe-activity.js';
import { probeActivitySnapshot, subscribeProbeActivity } from '../engine/probe-activity.js';
import { useSharedClock } from './use-shared-clock.js';

/** The running tool checks, with the shared clock ticking while any probe runs. */
export function useProbeActivity(): Readonly<{ snapshot: ProbeActivitySnapshot; now: number }> {
  const snapshot = useSyncExternalStore(subscribeProbeActivity, probeActivitySnapshot);
  const now = useSharedClock({ active: snapshot.probes.length > 0 });
  return { snapshot, now };
}

/** The tool check that has run ten seconds or more (`OpenCode CLI sign-in 12s`), else null. */
export function useSlowProbeText(): string | null {
  const { snapshot, now } = useProbeActivity();
  return slowProbeText(snapshot.probes, now);
}
