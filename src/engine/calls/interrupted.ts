import type { WorkflowState } from '../../core/schemas/workflow.js';
import { deriveRunStatus, processWentAway } from '../../core/sessions/run-status.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { readRunEvents } from '../events/replay.js';
import type { EngineEvent, EngineEventOf, EventBus } from '../events/types.js';
import { projectRunnerCallEvents } from './event-projection.js';
import { runnerCallErrorEvent } from './status.js';

type RunnerCallEngineEvent = Extract<EngineEvent, { type: `runner_call_${string}` }>;

type OpenCall = {
  started: EngineEventOf<'runner_call_started'>;
  lastTs: number;
  nativeSessionId: string | null;
};

const PROCESS_EXIT_MESSAGE = 'SPLITBRIEF exited';

function isRunnerCallEvent(event: EngineEvent): event is RunnerCallEngineEvent {
  return event.type.startsWith('runner_call_');
}

/**
 * The calls a process left open when it went away, each closed as interrupted. Call ids restart
 * with the process, so only the calls started since the last run start or resume are its own; a
 * call stays open until its completion or its error. A close is dated at the last thing its call
 * reported, so the resume that records it and a screen that reads the log first build one event.
 * That date is only a lower bound — nothing saw the call end — so the close says its end is unknown.
 */
export function interruptedCallEvents(
  events: readonly EngineEvent[],
  rootDir: string,
): EngineEvent[] {
  const segmentStart = events.findLastIndex(
    (event) => event.type === 'workflow_started' || event.type === 'workflow_resumed',
  );
  const open = new Map<string, OpenCall>();
  for (const event of events.slice(segmentStart + 1)) {
    if (!isRunnerCallEvent(event)) continue;
    if (event.type === 'runner_call_started') {
      open.set(event.callId, { started: event, lastTs: event.ts, nativeSessionId: null });
      continue;
    }
    const call = open.get(event.callId);
    if (call === undefined) continue;
    if (event.type === 'runner_call_completed' || event.type === 'runner_call_error') {
      open.delete(event.callId);
      continue;
    }
    call.lastTs = Math.max(call.lastTs, event.ts);
    if (event.type === 'runner_call_session_id') call.nativeSessionId = event.nativeSessionId;
  }

  return [...open.values()].flatMap(({ started, lastTs, nativeSessionId }) => {
    const { type: _type, ts, phase, sequence, ...context } = started;
    return projectRunnerCallEvents(
      runnerCallErrorEvent(context, {
        startedAt: ts,
        endedAt: lastTs,
        status: 'aborted',
        error: { code: 'runner_interrupted', message: PROCESS_EXIT_MESSAGE },
        usage: null,
        nativeSessionId,
        partial: false,
        endUnknown: true,
      }),
      { phase, rootDir, sequence },
    );
  });
}

/**
 * Records the calls of a run whose process went away mid-step as interrupted. The first writer
 * after the crash calls it before it writes anything else: the resume, before it restores or
 * re-runs a step, and End run at rest, before the run closes. A closed run is no longer read as
 * one whose process went away, so its log must already carry the cut.
 */
export async function recordInterruptedCalls(
  scope: SessionRef & { bus: EventBus },
  state: WorkflowState,
): Promise<void> {
  if (!processWentAway(deriveRunStatus({ state, liveness: 'not-alive' }))) return;
  const { events } = await readRunEvents(scope);
  for (const event of interruptedCallEvents(events, scope.projectDir)) scope.bus.publish(event);
}
