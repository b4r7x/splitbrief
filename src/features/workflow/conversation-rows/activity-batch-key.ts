import { isSettledSection, type Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import {
  COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT,
  runnerActivityDisplayKey,
} from './activity-batch-model.js';
import { isTranscriptRowlessEvent } from './event-rows/visibility.js';

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
    if (isSettledSection(section)) {
      flushBatch();
      continue;
    }

    for (const [index, event] of section.items.entries()) {
      const globalIndex = section.startIndex + index;
      if (isTranscriptRowlessEvent(event)) continue;
      if (event.type === 'runner_call_activity') {
        if (batch === null || batch.callId !== event.callId) {
          flushBatch();
          batch = {
            callId: event.callId,
            firstIndex: globalIndex,
            itemKeys: new Set(),
          };
        }
        const key = runnerActivityDisplayKey(event);
        if (key !== null) batch.itemKeys.add(key);
        continue;
      }

      if (batch !== null) {
        flushBatch();
      }
    }
  }

  flushBatch();
  return latestKey;
}
