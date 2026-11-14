import { phaseStage } from '../phases/rail.js';
import {
  type SectionableEvent,
  type TaskEndEvent,
  isTaskStartedEvent,
  isTaskResetEvent,
  isTaskEndEvent,
} from './events.js';

interface TaskRange<TEvent extends SectionableEvent> {
  taskId: string;
  startIdx: number;
  endIdx: number;
  startEvent: { title: string; file?: string | undefined };
  endEvent?: (TEvent & TaskEndEvent) | undefined;
  abandoned: boolean;
}

// A recovery that ends or resets a brief resolves right after it; its outcome closes that range.
function outcomeEnd(events: readonly SectionableEvent[], index: number): number {
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
function joinBuildRowsToBriefs<TEvent extends SectionableEvent>(
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

function abandonOpenTask<TEvent extends SectionableEvent>(
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

export function taskRangesOf<TEvent extends SectionableEvent>(
  events: TEvent[],
): TaskRange<TEvent>[] {
  const taskRanges: TaskRange<TEvent>[] = [];
  const openTasks = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (isTaskStartedEvent(ev)) {
      // Briefs run one at a time: a brief that starts ends every open range. Another brief's
      // attempt keeps its rows up to its last own row, and the rows after it join the gap.
      for (const openId of [...openTasks.keys()]) {
        const end =
          openId === ev.taskId
            ? i - 1
            : events.findLastIndex((event, idx) => idx < i && event.taskId === openId);
        abandonOpenTask(taskRanges, openTasks, openId, end);
      }
      const latest = taskRanges.at(-1);
      if (latest?.abandoned && latest.taskId === ev.taskId) {
        latest.abandoned = false;
        latest.endIdx = -1;
        latest.startEvent = ev;
        openTasks.set(ev.taskId, taskRanges.length - 1);
        continue;
      }
      const idx = taskRanges.length;
      taskRanges.push({
        taskId: ev.taskId,
        startIdx: i,
        endIdx: -1,
        startEvent: ev,
        abandoned: false,
      });
      openTasks.set(ev.taskId, idx);
    } else if (isTaskResetEvent(ev)) {
      abandonOpenTask(taskRanges, openTasks, ev.taskId, outcomeEnd(events, i));
    } else if (isTaskEndEvent(ev)) {
      const rangeIdx = openTasks.get(ev.taskId);
      if (rangeIdx != null) {
        const range = taskRanges[rangeIdx];
        if (!range) continue;
        range.endIdx = outcomeEnd(events, i);
        range.endEvent = ev;
        range.abandoned = false;
        openTasks.delete(ev.taskId);
      } else if (ev.type === 'task_skipped') {
        taskRanges.push({
          taskId: ev.taskId,
          startIdx: i,
          endIdx: outcomeEnd(events, i),
          startEvent: ev,
          endEvent: ev,
          abandoned: false,
        });
      }
    }
  }

  joinBuildRowsToBriefs(events, taskRanges);
  return taskRanges;
}
