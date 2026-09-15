import type { RunRecord } from '../../core/sessions/run-record.js';
import { readRunEvents, type RunReplay } from '../../engine/events/replay.js';
import { loadEvents } from '../../stores/workflow/actions/load.js';
import { hydrateFromState } from '../../stores/workflow/actions/hydrate.js';

/**
 * A past run, put back on the workflow screen: its session log replayed into the stores, then the
 * saved state laid over the three facts the log cannot settle — the phase it stopped in, the brief
 * list, and what it spent. One read at the navigation event; the live bus appends from there.
 */
export async function hydrateRun(record: RunRecord): Promise<void> {
  const replay = await readRunEvents(record.ref);
  loadEvents(replay.events);
  if (record.hydration.kind !== 'loaded') return;
  hydrateFromState(record.hydration.state, {
    endedAt: lastRunEventTs(replay) ?? runRecordEnd(record),
  });
}

/**
 * When the run stopped, read off the last thing it actually wrote. The replay's own two markers
 * bracket that history and carry the replay's clock, not the run's, so they are not an answer.
 */
function lastRunEventTs(replay: RunReplay): number | null {
  for (let index = replay.events.length - 1; index >= 0; index--) {
    const event = replay.events[index];
    if (event === undefined) continue;
    if (event.type === 'replay_started' || event.type === 'replay_complete') continue;
    return event.ts;
  }
  return null;
}

/**
 * A run that left no log still has to stop its clock somewhere, and its own record says how long it
 * took — a header reading `0:00` beside phases measured in minutes states two durations.
 */
function runRecordEnd(record: RunRecord): number | null {
  const startedAt = Date.parse(record.startedAt ?? '');
  const totalMs = record.summary?.totalTime;
  if (Number.isNaN(startedAt) || totalMs === undefined) return null;
  return startedAt + totalMs;
}
