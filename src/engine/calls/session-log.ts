import type { SessionLogEventEntry } from '../../core/schemas/session-log.js';
import { toEngineEventEntry } from '../../core/state/persistence.js';
import type { EngineEvent } from '../events/types.js';
import { projectRunnerCallEvent } from './event-projection.js';
import type { RunnerCallEvent } from './types.js';

type RunnerCallEngineEvent = Extract<EngineEvent, { type: `runner_call_${string}` }>;

type RunnerCallSessionLogProjectionOptions = Parameters<typeof projectRunnerCallEvent>[1];

export function runnerCallEngineEventToSessionLogEntry(
  event: RunnerCallEngineEvent,
): SessionLogEventEntry {
  return toEngineEventEntry(event);
}

export function runnerCallEventToSessionLogEntry(
  event: RunnerCallEvent,
  opts: RunnerCallSessionLogProjectionOptions,
): SessionLogEventEntry | null {
  const projected = projectRunnerCallEvent(event, opts);
  return projected === null ? null : runnerCallEngineEventToSessionLogEntry(projected);
}
