import type { Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import { isTranscriptRowlessEvent } from './event-rows/visibility.js';

type RunnerActivityEvent = EngineEventOf<'runner_call_activity'>;

export interface RunnerActivityBatch {
  callId: string;
  firstIndex: number;
  events: RunnerActivityEvent[];
  lastEvent: RunnerActivityEvent;
}

export type TranscriptWalkStep =
  | { kind: 'activity-batch'; batch: RunnerActivityBatch }
  | { kind: 'event'; event: EngineEvent; globalIndex: number };

// The single traversal both the projection and the clickable-action builders consume, so the
// consecutive-`runner_call_activity` batching stays byte-identical between rendered rows and their
// click targets. A batch closes on a call-id change, a completed-task boundary, any non-rowless
// event (yielded before that event), or the end of the transcript; row-less events never split it.
export function* walkTranscript(
  sections: readonly Section<EngineEvent>[],
): Generator<TranscriptWalkStep> {
  let activityBatch: RunnerActivityBatch | null = null;

  for (const section of sections) {
    if (section.type === 'completed-task') {
      if (activityBatch !== null) {
        yield { kind: 'activity-batch', batch: activityBatch };
        activityBatch = null;
      }
      continue;
    }
    for (const [index, event] of section.items.entries()) {
      const globalIndex = section.startIndex + index;
      if (event.type === 'runner_call_activity') {
        if (activityBatch !== null && activityBatch.callId === event.callId) {
          activityBatch.events.push(event);
          activityBatch.lastEvent = event;
        } else {
          if (activityBatch !== null) yield { kind: 'activity-batch', batch: activityBatch };
          activityBatch = {
            callId: event.callId,
            firstIndex: globalIndex,
            events: [event],
            lastEvent: event,
          };
        }
        continue;
      }

      if (!isTranscriptRowlessEvent(event) && activityBatch !== null) {
        yield { kind: 'activity-batch', batch: activityBatch };
        activityBatch = null;
      }
      yield { kind: 'event', event, globalIndex };
    }
  }

  if (activityBatch !== null) yield { kind: 'activity-batch', batch: activityBatch };
}
