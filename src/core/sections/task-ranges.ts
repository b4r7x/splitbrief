import { phaseStage } from '../phases/rail.js';
import type { SectionableEvent, TaskEndEvent } from './events.js';

export interface TaskRange<TEvent extends SectionableEvent> {
  taskId: string;
  startIdx: number;
  endIdx: number;
  startEvent: { title: string; file?: string | undefined };
  endEvent?: (TEvent & TaskEndEvent) | undefined;
  abandoned: boolean;
}

// A recovery that ends or resets a brief resolves right after it; its outcome closes that range.
export function outcomeEnd(events: readonly SectionableEvent[], index: number): number {
  return events[index + 1]?.type === 'recovery_resolved' ? index + 1 : index;
}

function isBuildRow(event: SectionableEvent | undefined, hasReviewStage: boolean): boolean {
  return (
    event?.phase !== undefined &&
    phaseStage(event.phase) === 'build' &&
    event.type !== 'review_started' &&
    event.type !== 'review_completed' &&
    !(hasReviewStage && event.type === 'review_fix_started')
  );
}

// A build row between two briefs joins the brief that closed before it; the build rows left before a
// brief (the run start, a fix cycle's re-entry) join that brief. The tail after the last brief stays.
// A consult on a brief before it starts opens its range, and so does the halt of a brief skipped
// before it started, so that choice and its outcome stay in one section.
export function joinBuildRowsToBriefs<TEvent extends SectionableEvent>(
  events: TEvent[],
  taskRanges: TaskRange<TEvent>[],
): void {
  for (let r = 0; r < taskRanges.length; r++) {
    const range = taskRanges[r];
    const previous = taskRanges[r - 1];
    if (!range || (previous && previous.endIdx < 0)) return;
    let gapStart = previous ? previous.endIdx + 1 : 0;
    const hasReviewStage = events
      .slice(gapStart, range.startIdx)
      .some(
        (event) =>
          event.type === 'review_started' ||
          (event.phase !== undefined && phaseStage(event.phase) === 'review'),
      );
    const neverStarted = events[range.startIdx]?.type === 'task_skipped';
    const ownStartIdx = events.findIndex(
      (event, idx) =>
        idx >= gapStart &&
        idx < range.startIdx &&
        event?.taskId === range.taskId &&
        (event.type === 'consult_answered' || (neverStarted && event.type === 'recovery_prompted')),
    );
    const gapEnd = ownStartIdx >= 0 ? ownStartIdx : range.startIdx;
    if (previous?.endEvent) {
      while (
        gapStart < gapEnd &&
        events[gapStart]?.type !== 'review_fix_started' &&
        isBuildRow(events[gapStart], hasReviewStage)
      ) {
        gapStart++;
      }
      previous.endIdx = gapStart - 1;
    }
    if (ownStartIdx >= 0) {
      range.startIdx = ownStartIdx;
    }
    while (range.startIdx > gapStart && isBuildRow(events[range.startIdx - 1], hasReviewStage)) {
      range.startIdx--;
    }
  }
}

export function abandonOpenTask<TEvent extends SectionableEvent>(
  taskRanges: TaskRange<TEvent>[],
  openTasks: Map<string, number>,
  taskId: string,
  endIdx: number,
): void {
  const rangeIdx = openTasks.get(taskId);
  if (rangeIdx === undefined) return;
  const range = taskRanges[rangeIdx];
  if (!range) return;
  range.endIdx = Math.max(range.startIdx, endIdx);
  range.endEvent = undefined;
  range.abandoned = true;
  openTasks.delete(taskId);
}
