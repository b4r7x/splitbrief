import { formatTime } from '../../utils/format-time.js';
import { CLI_TOOL_CATALOG, CLI_TOOL_IDS, type CliToolId } from '../runners/cli-tool-catalog.js';

export type ProbeCheck = 'version' | 'sign-in' | 'model list' | 'options';

export type ProbeActivity = Readonly<{
  id: number;
  tool: CliToolId;
  check: ProbeCheck;
  startedAt: number;
}>;

export type ProbeActivitySnapshot = Readonly<{
  probes: readonly ProbeActivity[];
  tools: ReadonlyArray<Readonly<{ tool: CliToolId; state: 'checking' | 'checked' }>>;
}>;

export const SLOW_PROBE_AFTER_MS = 10_000;

/** The longest-running probe at or past `SLOW_PROBE_AFTER_MS`; a tie goes to the tool the catalog lists first. */
export function slowestProbe(probes: readonly ProbeActivity[], now: number): ProbeActivity | null {
  let slowest: ProbeActivity | null = null;
  for (const probe of probes) {
    if (now - probe.startedAt < SLOW_PROBE_AFTER_MS) continue;
    if (!slowest || runsLonger(probe, slowest)) slowest = probe;
  }
  return slowest;
}

/** A probe's check and how long it has run: `sign-in 12s`. */
export function probeCheckText(probe: ProbeActivity, now: number): string {
  return `${probe.check} ${formatTime(now - probe.startedAt)}`;
}

/** The slowest probe as a person reads it: `OpenCode CLI sign-in 12s`. */
export function slowProbeText(probes: readonly ProbeActivity[], now: number): string | null {
  const slowest = slowestProbe(probes, now);
  if (!slowest) return null;
  return `${CLI_TOOL_CATALOG[slowest.tool].displayName} ${probeCheckText(slowest, now)}`;
}

function runsLonger(probe: ProbeActivity, than: ProbeActivity): boolean {
  if (probe.startedAt !== than.startedAt) return probe.startedAt < than.startedAt;
  return CLI_TOOL_IDS.indexOf(probe.tool) < CLI_TOOL_IDS.indexOf(than.tool);
}
