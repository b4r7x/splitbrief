import { readEvents } from '../../../core/sessions/log-reader.js';
import type { SessionLogEventEntry } from '../../../core/schemas/session-log.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { isRecord } from '../../../utils/type-guards.js';
import { entryTimestamp } from '../../events/replay.js';

/**
 * One event line of a session log, as much of it as a brief's time needs. `taskId` names the brief
 * the mark belongs to; a stop that cut a brief mid-call belongs to that brief.
 */
export type BriefMark = Readonly<{ type: string; ts: number; taskId?: string }>;

const BRIEF_ENDS = new Set(['task_completed', 'task_skipped', 'task_full_fail']);
const RUN_STOPS = new Set([
  'turn_interrupted',
  'recovery_prompted',
  'workflow_cancelled',
  'workflow_complete',
]);
const RUN_STARTS = new Set(['workflow_started', 'workflow_resumed']);

/**
 * The time a brief has worked by `now`, in log order. Its `task_started` opens a stretch; a stop, a
 * halt, a cancellation or a completion of the run closes it at that mark. A stop that cut the brief
 * mid-call and that the same process continued, by a steer, a `/resume` or a watchdog park, opens a
 * stretch again at the brief's next call: the rule `readUnresumedBriefCut` applies to a cut. A
 * stretch that a process left open, by a crash or a restart, ends at the latest mark it holds. The
 * stretch still open at the end of the log is the one running, and it runs to `now`. The time the
 * run sat stopped, parked or halted is no stretch. An end of the brief starts its count again.
 */
export function briefWorkedMs(marks: readonly BriefMark[], taskId: string, now: number): number {
  let total = 0;
  let stretch: { start: number; latest: number } | null = null;
  let cut = false;
  for (const mark of marks) {
    const own = mark.taskId === taskId;
    if (own && BRIEF_ENDS.has(mark.type)) {
      total = 0;
      stretch = null;
      cut = false;
      continue;
    }
    if (stretch !== null) {
      if (RUN_STOPS.has(mark.type)) {
        total += Math.max(0, mark.ts - stretch.start);
        stretch = null;
        cut = own && mark.type === 'turn_interrupted';
      } else if (RUN_STARTS.has(mark.type) || mark.type === 'task_started') {
        total += Math.max(0, stretch.latest - stretch.start);
        stretch = null;
      } else {
        stretch.latest = Math.max(stretch.latest, mark.ts);
      }
    } else if (RUN_STARTS.has(mark.type) || RUN_STOPS.has(mark.type)) {
      cut = false;
    } else if (cut && mark.type === 'runner_call_started') {
      if (own) stretch = { start: mark.ts, latest: mark.ts };
      cut = false;
    }
    if (own && mark.type === 'task_started') {
      stretch = { start: mark.ts, latest: mark.ts };
      cut = false;
    }
  }
  if (stretch !== null) total += Math.max(0, now - stretch.start);
  return total;
}

function markTaskId(entry: SessionLogEventEntry): string | undefined {
  if (entry.taskId !== undefined) return entry.taskId;
  const { data } = entry;
  if (!isRecord(data)) return undefined;
  if (typeof data.taskId === 'string') return data.taskId;
  const { step } = data;
  return data.at === 'mid-step' &&
    isRecord(step) &&
    step.kind === 'brief' &&
    typeof step.taskId === 'string'
    ? step.taskId
    : undefined;
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
    const markId = markTaskId(entry);
    marks.push({ type: entry.type, ts, ...(markId !== undefined && { taskId: markId }) });
  }
  return briefWorkedMs(marks, taskId, Date.now());
}
