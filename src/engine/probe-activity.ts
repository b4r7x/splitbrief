import type {
  ProbeActivity,
  ProbeActivitySnapshot,
  ProbeCheck,
} from '../core/discovery/probe-activity.js';
import type { CliToolId } from '../core/runners/cli-tool-catalog.js';

const probes = new Map<number, ProbeActivity>();
const toolChecks = new Map<CliToolId, number>();
const listeners = new Set<() => void>();
let nextId = 1;
let snapshot: ProbeActivitySnapshot = Object.freeze({ probes: [], tools: [] });

function publish(): void {
  snapshot = Object.freeze({
    probes: Object.freeze([...probes.values()]),
    tools: Object.freeze(
      [...toolChecks].map(([tool, running]) =>
        Object.freeze({ tool, state: running > 0 ? ('checking' as const) : ('checked' as const) }),
      ),
    ),
  });
  for (const listener of listeners) listener();
}

/** Lists `run` as a running probe of `activity.tool` until it settles. */
export async function trackProbe<T>(
  activity: Readonly<{ tool: CliToolId; check: ProbeCheck }>,
  run: () => Promise<T>,
): Promise<T> {
  const id = nextId++;
  probes.set(
    id,
    Object.freeze({ id, tool: activity.tool, check: activity.check, startedAt: Date.now() }),
  );
  publish();
  try {
    return await run();
  } finally {
    probes.delete(id);
    publish();
  }
}

/** Shows `tool` as checking while any of its checks runs, and as checked after the last one. */
export async function trackToolCheck<T>(tool: CliToolId, run: () => Promise<T>): Promise<T> {
  toolChecks.set(tool, (toolChecks.get(tool) ?? 0) + 1);
  publish();
  try {
    return await run();
  } finally {
    toolChecks.set(tool, (toolChecks.get(tool) ?? 1) - 1);
    publish();
  }
}

export function subscribeProbeActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function probeActivitySnapshot(): ProbeActivitySnapshot {
  return snapshot;
}

// Test escape hatch — see docs/STORES-AND-UI.md#test-escape-hatches. Forgets every probe and tool
// check, so suite isolation never depends on the tools a previous test checked.
export function __testResetProbeActivity(): void {
  probes.clear();
  toolChecks.clear();
  publish();
}
