import { isImplementerPhase } from '../phases.js';
import type { Phase, TaskCompletionMethod } from '../schemas/enums.js';

export interface SectionableEvent {
  type: string;
  ts?: number;
  phase?: Phase;
}

type TaskStartedEvent = {
  type: 'task_started';
  taskId: string;
  index: number;
  title: string;
  file: string;
};
type TaskCompletedEvent = {
  type: 'task_completed';
  taskId: string;
  method: TaskCompletionMethod;
  retries: number;
  duration: number;
};
type TaskSkippedEvent = { type: 'task_skipped'; taskId: string; reason: string };
type TaskFullFailEvent = { type: 'task_full_fail'; taskId: string };
type TaskResetEvent = { type: 'task_reset'; taskId: string };
type DiffEvent = { type: 'implementer_generate_done'; diff?: string | undefined };
type TaskEndEvent = TaskCompletedEvent | TaskSkippedEvent | TaskFullFailEvent;

interface TaskRange<TEvent extends SectionableEvent> {
  taskId: string;
  startIdx: number;
  endIdx: number;
  startEvent: TEvent & TaskStartedEvent;
  endEvent?: (TEvent & TaskEndEvent) | undefined;
  abandoned: boolean;
}

function isTaskStartedEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & TaskStartedEvent {
  return event.type === 'task_started';
}

function isTaskEndEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & TaskEndEvent {
  return (
    event.type === 'task_completed' ||
    event.type === 'task_skipped' ||
    event.type === 'task_full_fail'
  );
}

function isTaskResetEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & TaskResetEvent {
  return event.type === 'task_reset';
}

function isDiffEvent<TEvent extends SectionableEvent>(event: TEvent): event is TEvent & DiffEvent {
  return event.type === 'implementer_generate_done';
}

// The diff's stable identity is its global render index, not its timestamp: publishers stamp events
// with `Date.now()`, so two diffs produced in the same millisecond would collide on a type+ts key and
// expand/collapse together. The global index is unique per rendered event and survives appends.
export function diffEventKey(event: SectionableEvent, globalIndex: number): string {
  return `${event.type}:${globalIndex}`;
}

export function findLatestRenderableDiffKey<TEvent extends SectionableEvent>(
  sections: Section<TEvent>[],
): string | null {
  for (let sectionIndex = sections.length - 1; sectionIndex >= 0; sectionIndex--) {
    const section = sections[sectionIndex];
    if (!section || section.type === 'completed-task') continue;
    for (let index = section.items.length - 1; index >= 0; index--) {
      const event = section.items[index];
      if (!event) continue;
      if (isDiffEvent(event) && event.diff) {
        return diffEventKey(event, section.startIndex + index);
      }
    }
  }
  return null;
}

export type Section<TEvent extends SectionableEvent = SectionableEvent> =
  | { type: 'events'; items: TEvent[]; startIndex: number }
  | {
      type: 'completed-task';
      items: TEvent[];
      startIndex: number;
      summary: {
        index: number;
        /** The brief's own id, which every other surface names it by. */
        id: string;
        title: string;
        method: TaskCompletionMethod;
        retries: number;
        duration: number;
        file?: string;
        reason?: string;
      };
    }
  | { type: 'active-task'; items: TEvent[]; startIndex: number };

export function groupEventsIntoSections<TEvent extends SectionableEvent>(
  events: TEvent[],
): Section<TEvent>[] {
  const taskRanges: TaskRange<TEvent>[] = [];
  const openTasks = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (isTaskStartedEvent(ev)) {
      abandonOpenTask(taskRanges, openTasks, ev.taskId, i - 1);
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
      abandonOpenTask(taskRanges, openTasks, ev.taskId, i);
    } else if (isTaskEndEvent(ev)) {
      const rangeIdx = openTasks.get(ev.taskId);
      if (rangeIdx != null) {
        const range = taskRanges[rangeIdx];
        if (!range) continue;
        range.endIdx = i;
        range.endEvent = ev;
        range.abandoned = false;
        openTasks.delete(ev.taskId);
      }
    }
  }

  joinBuildRowsToBriefs(events, taskRanges);

  const sections: Section<TEvent>[] = [];
  let cursor = 0;

  for (const range of taskRanges) {
    if (cursor < range.startIdx) {
      sections.push({
        type: 'events',
        items: events.slice(cursor, range.startIdx),
        startIndex: cursor,
      });
    }

    if (range.abandoned && range.endIdx >= range.startIdx) {
      sections.push({
        type: 'events',
        items: events.slice(range.startIdx, range.endIdx + 1),
        startIndex: range.startIdx,
      });
      cursor = range.endIdx + 1;
    } else if (range.endIdx >= 0 && range.endEvent) {
      const endEvent = range.endEvent;
      if (endEvent.type === 'task_completed') {
        sections.push({
          type: 'completed-task',
          items: events.slice(range.startIdx, range.endIdx + 1),
          startIndex: range.startIdx,
          summary: {
            index: range.startEvent.index + 1,
            id: range.taskId,
            title: range.startEvent.title,
            method: endEvent.method,
            retries: endEvent.retries,
            duration: endEvent.duration,
            file: range.startEvent.file,
          },
        });
      } else if (endEvent.type === 'task_skipped') {
        sections.push({
          type: 'completed-task',
          items: events.slice(range.startIdx, range.endIdx + 1),
          startIndex: range.startIdx,
          summary: {
            index: range.startEvent.index + 1,
            id: range.taskId,
            title: range.startEvent.title,
            method: 'skipped',
            retries: 0,
            duration: 0,
            reason: endEvent.reason,
          },
        });
      } else if (endEvent.type === 'task_full_fail') {
        sections.push({
          type: 'completed-task',
          items: events.slice(range.startIdx, range.endIdx + 1),
          startIndex: range.startIdx,
          summary: {
            index: range.startEvent.index + 1,
            id: range.taskId,
            title: range.startEvent.title,
            method: 'failed',
            retries: 0,
            duration: 0,
            file: range.startEvent.file,
          },
        });
      }
      cursor = range.endIdx + 1;
    } else {
      sections.push({
        type: 'active-task',
        items: events.slice(range.startIdx),
        startIndex: range.startIdx,
      });
      cursor = events.length;
      break;
    }
  }

  if (cursor < events.length) {
    sections.push({ type: 'events', items: events.slice(cursor), startIndex: cursor });
  }

  return sections;
}

function isBuildRow(event: SectionableEvent | undefined): boolean {
  return event?.phase !== undefined && isImplementerPhase(event.phase);
}

// A build row between two briefs joins the brief that closed before it; the build rows left before a
// brief (the run start, a fix cycle's re-entry) join that brief. The tail after the last brief stays.
function joinBuildRowsToBriefs<TEvent extends SectionableEvent>(
  events: TEvent[],
  taskRanges: TaskRange<TEvent>[],
): void {
  for (let r = 0; r < taskRanges.length; r++) {
    const range = taskRanges[r];
    const previous = taskRanges[r - 1];
    if (!range || (previous && previous.endIdx < 0)) return;
    let gapStart = previous ? previous.endIdx + 1 : 0;
    if (previous?.endEvent) {
      while (gapStart < range.startIdx && isBuildRow(events[gapStart])) gapStart++;
      previous.endIdx = gapStart - 1;
    }
    while (range.startIdx > gapStart && isBuildRow(events[range.startIdx - 1])) range.startIdx--;
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
