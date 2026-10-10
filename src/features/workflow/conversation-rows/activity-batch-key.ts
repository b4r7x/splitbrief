import type { Section } from '../../../core/sections/event-sections.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import {
  COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT,
  runnerActivityDisplayKey,
} from './activity-batch-model.js';
import { walkTranscript } from './transcript-walk.js';

export function activityBatchKey(firstIndex: number, callId: string): string {
  return `activity-batch:${firstIndex}:${callId}`;
}

export function findLatestExpandableActivityBatchKey(
  sections: Section<EngineEvent>[],
): string | null {
  let latestKey: string | null = null;
  for (const step of walkTranscript(sections)) {
    if (step.kind !== 'activity-batch') continue;
    const itemKeys = new Set<string>();
    for (const event of step.batch.events) {
      const key = runnerActivityDisplayKey(event);
      if (key !== null) itemKeys.add(key);
    }
    if (itemKeys.size > COLLAPSED_ACTIVITY_BATCH_ITEM_COUNT) {
      latestKey = activityBatchKey(step.batch.firstIndex, step.batch.callId);
    }
  }
  return latestKey;
}
