import type { Section } from '../../../core/sections/event-sections.js';
import { stripRecoveryResetClause } from '../../../core/recovery/reset-clock.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import { isTranscriptRowlessEvent } from './event-rows/visibility.js';

type RunnerActivityEvent = EngineEventOf<'runner_call_activity'>;

export interface RunnerActivityBatch {
  callId: string;
  firstIndex: number;
  events: RunnerActivityEvent[];
  lastEvent: RunnerActivityEvent;
}

/** The halt, the action a person chose, the reset it made and the outcome it reached. */
export interface RecoveryFold {
  firstIndex: number;
  issueId: string;
  prompted?: EngineEventOf<'recovery_prompted'>;
  selected?: EngineEventOf<'recovery_action_selected'>;
  reset?: EngineEventOf<'task_reset'>;
  resolved?: EngineEventOf<'recovery_resolved'>;
}

export type TranscriptWalkStep =
  | { kind: 'activity-batch'; batch: RunnerActivityBatch }
  | { kind: 'recovery'; recovery: RecoveryFold }
  | { kind: 'event'; event: EngineEvent; globalIndex: number };

// The single traversal both the projection and the clickable-action builders consume, so the
// consecutive-`runner_call_activity` batching stays byte-identical between rendered rows and their
// click targets. A batch closes on a call-id change, a completed-task boundary, any non-rowless
// event (yielded before that event), or the end of the transcript; row-less events never split it.
// A recovery folds the same way: its prompt or its selection opens the fold, and the selection,
// the reset and the outcome of that issue join it until another row-producing event closes it.
// A prompt the error row before it already states opens nothing. A brief its recovery restarted
// keeps the one header it opened with: the Recovery row already says it went back to pending.
export function* walkTranscript(
  sections: readonly Section<EngineEvent>[],
): Generator<TranscriptWalkStep> {
  let activityBatch: RunnerActivityBatch | null = null;
  let recovery: RecoveryFold | null = null;
  let lastRowEvent: EngineEvent | null = null;
  let openHeader: EngineEventOf<'task_started'> | null = null;

  function* flush(): Generator<TranscriptWalkStep> {
    if (activityBatch !== null) yield { kind: 'activity-batch', batch: activityBatch };
    if (recovery !== null) yield { kind: 'recovery', recovery };
    activityBatch = null;
    recovery = null;
  }

  for (const section of sections) {
    if (section.type === 'completed-task') {
      yield* flush();
      lastRowEvent = null;
      openHeader = null;
      continue;
    }
    for (const [index, event] of section.items.entries()) {
      const globalIndex = section.startIndex + index;
      if (event.type === 'runner_call_activity') {
        if (activityBatch !== null && activityBatch.callId === event.callId) {
          activityBatch.events.push(event);
          activityBatch.lastEvent = event;
        } else {
          yield* flush();
          lastRowEvent = null;
          activityBatch = {
            callId: event.callId,
            firstIndex: globalIndex,
            events: [event],
            lastEvent: event,
          };
        }
        continue;
      }

      if (recovery !== null && joinsRecovery(recovery, event)) continue;
      if (isTranscriptRowlessEvent(event)) {
        yield { kind: 'event', event, globalIndex };
        continue;
      }
      yield* flush();
      if (event.type === 'recovery_prompted' && restatesHalt(lastRowEvent, event)) continue;
      if (
        event.type === 'recovery_prompted' ||
        event.type === 'recovery_action_selected' ||
        event.type === 'recovery_resolved'
      ) {
        recovery = { firstIndex: globalIndex, issueId: event.issueId };
        joinsRecovery(recovery, event);
        lastRowEvent = event;
        continue;
      }
      if (event.type === 'task_started') {
        if (openHeader !== null && sameHeader(openHeader, event)) continue;
        openHeader = event;
      }
      lastRowEvent = event;
      yield { kind: 'event', event, globalIndex };
    }
  }

  yield* flush();
}

// A restart the recovery made on the same worker restates the header; one on another seat or
// profile is news the reader needs.
function sameHeader(
  open: EngineEventOf<'task_started'>,
  next: EngineEventOf<'task_started'>,
): boolean {
  return (
    open.taskId === next.taskId &&
    open.tool === next.tool &&
    open.model === next.model &&
    open.implementerProfile === next.implementerProfile
  );
}

function joinsRecovery(recovery: RecoveryFold, event: EngineEvent): boolean {
  if (recovery.resolved !== undefined) return false;
  switch (event.type) {
    // A resumed run prompts the same issue again; it is still the one halt.
    case 'recovery_prompted':
      if (event.issueId !== recovery.issueId || recovery.selected !== undefined) return false;
      recovery.prompted = event;
      return true;
    case 'recovery_action_selected':
      if (event.issueId !== recovery.issueId || recovery.selected !== undefined) return false;
      recovery.selected = event;
      return true;
    case 'task_reset':
      if (recovery.selected === undefined || recovery.reset !== undefined) return false;
      recovery.reset = event;
      return true;
    case 'recovery_resolved':
      if (event.issueId !== recovery.issueId) return false;
      recovery.resolved = event;
      return true;
    default:
      return false;
  }
}

// The error row already names the halt; the prompt's card would say it a second time.
function restatesHalt(
  previous: EngineEvent | null,
  prompted: EngineEventOf<'recovery_prompted'>,
): boolean {
  return (
    previous?.type === 'error' &&
    previous.message.startsWith(stripRecoveryResetClause(prompted.headline))
  );
}
