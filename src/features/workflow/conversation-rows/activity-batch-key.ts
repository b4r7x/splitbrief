import type { Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import {
  COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT,
  runnerActivityDisplayKey,
} from './activity-batch-model.js';

type RunnerActivityEvent = EngineEventOf<'runner_call_activity'>;

interface ActivityBatchScan {
  callId: string;
  firstIndex: number;
  itemKeys: Set<string>;
}

export function activityBatchKey(firstIndex: number, callId: string): string {
  return `activity-batch:${firstIndex}:${callId}`;
}

export function findLatestExpandableActivityBatchKey(
  sections: Section<EngineEvent>[],
): string | null {
  let latestKey: string | null = null;
  let batch: ActivityBatchScan | null = null;

  const flushBatch = (): void => {
    if (batch !== null && batch.itemKeys.size > COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT) {
      latestKey = activityBatchKey(batch.firstIndex, batch.callId);
    }
    batch = null;
  };

  for (const section of sections) {
    if (section.type === 'completed-task') {
      flushBatch();
      continue;
    }

    for (const [index, event] of section.items.entries()) {
      const globalIndex = section.startIndex + index;
      if (event.type === 'runner_call_activity') {
        if (batch === null || batch.callId !== event.callId) {
          flushBatch();
          batch = {
            callId: event.callId,
            firstIndex: globalIndex,
            itemKeys: new Set(),
          };
        }
        batch.itemKeys.add(activityItemKey(event));
        continue;
      }

      if (batch !== null && runnerCallId(event) !== batch.callId) {
        flushBatch();
      }
    }
  }

  flushBatch();
  return latestKey;
}

function activityItemKey(event: RunnerActivityEvent): string {
  return runnerActivityDisplayKey(event);
}

function runnerCallId(event: EngineEvent): string | null {
  switch (event.type) {
    case 'runner_call_started':
    case 'runner_call_text_delta':
    case 'runner_call_usage':
    case 'runner_call_tool_use':
    case 'runner_call_activity':
    case 'runner_call_session_id':
    case 'runner_call_artifact':
    case 'runner_call_warning':
    case 'runner_call_error':
    case 'runner_call_completed':
      return event.callId;
    default:
      return null;
  }
}
