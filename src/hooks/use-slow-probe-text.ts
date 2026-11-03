import { useSyncExternalStore } from 'react';
import {
  type ProbeActivitySnapshot,
  probeCheckText,
  probeSubjectName,
  slowestProbe,
} from '../core/discovery/probe-activity.js';
import { probeActivitySnapshot, subscribeProbeActivity } from '../engine/probe-activity.js';
import { useSharedClock } from './use-shared-clock.js';

/** The running tool checks, with the shared clock ticking while any probe runs. */
export function useProbeActivity(): Readonly<{ snapshot: ProbeActivitySnapshot; now: number }> {
  const snapshot = useSyncExternalStore(subscribeProbeActivity, probeActivitySnapshot);
  const now = useSharedClock({ active: snapshot.probes.length > 0 });
  return { snapshot, now };
}

/** The slow check's tool or provider and the check with its time, kept apart so a short row can cut the name. */
export type SlowProbeText = Readonly<{ tool: string; check: string }>;

/**
 * The check that has run ten seconds or more (`OpenCode CLI`, `sign-in 12s`), else null.
 * A surface that waits on one API provider passes it and reads that provider's checks only.
 */
export function useSlowProbeText(provider?: string): SlowProbeText | null {
  const { snapshot, now } = useProbeActivity();
  const probes =
    provider === undefined
      ? snapshot.probes
      : snapshot.probes.filter((probe) => 'provider' in probe && probe.provider === provider);
  const slowest = slowestProbe(probes, now);
  if (!slowest) return null;
  return { tool: probeSubjectName(slowest), check: probeCheckText(slowest, now) };
}
