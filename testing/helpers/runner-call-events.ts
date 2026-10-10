import type { Phase } from '../../src/core/schemas/enums.js';
import type { SessionLogEventEntry } from '../../src/core/schemas/session-log.js';
import { toEngineEventEntry } from '../../src/core/sessions/log-writer.js';
import { projectRunnerCallEvent } from '../../src/engine/calls/event-projection.js';
import type { RunnerCallEvent } from '../../src/engine/calls/types.js';
import { addEvent } from '../../src/stores/workflow/actions/event.js';
import { resetWorkflow } from '../../src/stores/workflow/actions/reset.js';
import {
  operationsStore,
  type OperationsState,
} from '../../src/stores/workflow/operations/state.js';

export type RunnerCallErrorEvent = Extract<RunnerCallEvent, { type: 'call_error' }>;
export type RunnerCallTerminalEvent = Extract<
  RunnerCallEvent,
  { type: 'call_error' | 'call_completed' }
>;

export function runnerCallErrors(events: readonly RunnerCallEvent[]): RunnerCallErrorEvent[] {
  return events.filter((event): event is RunnerCallErrorEvent => event.type === 'call_error');
}

export function runnerCallTerminals(events: readonly RunnerCallEvent[]): RunnerCallTerminalEvent[] {
  return events.filter(
    (event): event is RunnerCallTerminalEvent =>
      event.type === 'call_error' || event.type === 'call_completed',
  );
}

export function runnerCallLogEntry(
  event: RunnerCallEvent,
  opts: Parameters<typeof projectRunnerCallEvent>[1],
): SessionLogEventEntry | null {
  const projected = projectRunnerCallEvent(event, opts);
  return projected === null ? null : toEngineEventEntry(projected);
}

export function replayRunnerCallEventsIntoOperations(
  events: readonly RunnerCallEvent[],
  phase: Phase = 'planning',
): OperationsState {
  resetWorkflow();
  let sequence = 0;
  for (const event of events) {
    const projected = projectRunnerCallEvent(event, {
      rootDir: '/project',
      phase,
      sequence: ++sequence,
    });
    if (projected) addEvent(projected);
  }
  return operationsStore.get();
}
