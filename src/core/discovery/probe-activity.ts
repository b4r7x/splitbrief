import { formatTime } from '../../utils/format/time.js';
import { getRunnerIdentityDisplayName } from '../providers/catalog.js';
import { CLI_TOOL_CATALOG, CLI_TOOL_IDS, type CliToolId } from '../runners/cli-tool-catalog.js';

export type ProbeCheck = 'version' | 'sign-in' | 'model list' | 'options';

/** What a probe checks: a found CLI tool, or the API provider a seat names by its config id. */
export type ProbeSubject = Readonly<{ tool: CliToolId } | { provider: string }>;

export type ProbeActivity = ProbeSubject &
  Readonly<{
    id: number;
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

/** The name a person reads for what a probe checks: `OpenCode CLI`, `Ollama`. */
export function probeSubjectName(subject: ProbeSubject): string {
  return 'tool' in subject
    ? CLI_TOOL_CATALOG[subject.tool].displayName
    : getRunnerIdentityDisplayName('api', subject.provider);
}

/** The slowest probe as a person reads it: `OpenCode CLI sign-in 12s`. */
export function slowProbeText(probes: readonly ProbeActivity[], now: number): string | null {
  const slowest = slowestProbe(probes, now);
  if (!slowest) return null;
  return `${probeSubjectName(slowest)} ${probeCheckText(slowest, now)}`;
}

/** Catalog order for tools; a provider sorts after every tool. */
function subjectRank(subject: ProbeSubject): number {
  return 'tool' in subject ? CLI_TOOL_IDS.indexOf(subject.tool) : CLI_TOOL_IDS.length;
}

function runsLonger(probe: ProbeActivity, than: ProbeActivity): boolean {
  if (probe.startedAt !== than.startedAt) return probe.startedAt < than.startedAt;
  return subjectRank(probe) < subjectRank(than);
}
