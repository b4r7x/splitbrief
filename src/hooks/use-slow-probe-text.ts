import { useSyncExternalStore } from 'react';
import {
  type ProbeActivitySnapshot,
  probeCheckText,
  slowestProbe,
} from '../core/discovery/probe-activity.js';
import { CLI_TOOL_CATALOG } from '../core/runners/cli-tool-catalog.js';
import { probeActivitySnapshot, subscribeProbeActivity } from '../engine/probe-activity.js';
import { useSharedClock } from './use-shared-clock.js';

/** The running tool checks, with the shared clock ticking while any probe runs. */
export function useProbeActivity(): Readonly<{ snapshot: ProbeActivitySnapshot; now: number }> {
  const snapshot = useSyncExternalStore(subscribeProbeActivity, probeActivitySnapshot);
  const now = useSharedClock({ active: snapshot.probes.length > 0 });
  return { snapshot, now };
}

/** The slow check's tool and the check with its time, kept apart so a short row can cut the name. */
export type SlowProbeText = Readonly<{ tool: string; check: string }>;

/** The tool check that has run ten seconds or more (`OpenCode CLI`, `sign-in 12s`), else null. */
export function useSlowProbeText(): SlowProbeText | null {
  const { snapshot, now } = useProbeActivity();
  const slowest = slowestProbe(snapshot.probes, now);
  if (!slowest) return null;
  return { tool: CLI_TOOL_CATALOG[slowest.tool].displayName, check: probeCheckText(slowest, now) };
}
