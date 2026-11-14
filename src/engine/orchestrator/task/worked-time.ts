import {
  type BriefMark,
  briefMarkTaskId,
  type BriefMarkId,
  briefWorkedMs,
} from '../../../core/brief-clock.js';
import { readEvents } from '../../../core/sessions/log/reader.js';
import type { SessionLogEventEntry } from '../../../core/schemas/session-log.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { isRecord } from '../../../utils/type-guards.js';
import { entryTimestamp } from '../../events/replay.js';

function markIdFields(entry: SessionLogEventEntry): BriefMarkId {
  if (entry.taskId !== undefined) return { taskId: entry.taskId };
  const data = isRecord(entry.data) ? entry.data : {};
  if (typeof data.taskId === 'string') return { taskId: data.taskId };
  const at = typeof data.at === 'string' ? data.at : undefined;
  const step = isRecord(data.step) ? data.step : {};
  if (typeof step.kind === 'string' && typeof step.taskId === 'string') {
    return { ...(at !== undefined && { at }), step: { kind: step.kind, taskId: step.taskId } };
  }
  return { ...(at !== undefined && { at }) };
}

/**
 * `briefWorkedMs` by now, over the run's session log. Only the log entry shape is read: an old line
 * that today's event schema refuses still marks the brief's time.
 */
export async function readBriefWorkedMs(ref: SessionRef, taskId: string): Promise<number> {
  const marks: BriefMark[] = [];
  for await (const entry of readEvents(ref)) {
    const ts = entryTimestamp(entry.ts);
    if (ts === null) continue;
    const markId = briefMarkTaskId(markIdFields(entry));
    marks.push({ type: entry.type, ts, ...(markId !== undefined && { taskId: markId }) });
  }
  return briefWorkedMs(marks, taskId, Date.now());
}
