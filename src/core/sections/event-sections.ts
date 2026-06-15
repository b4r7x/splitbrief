import type { TaskCompletionMethod } from '../schemas/enums.js';

export interface SectionableEvent {
  type: string;
  ts?: number;
  phase?: string;
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
type DiffEvent = { type: 'implementer_generate_done'; diff?: string | undefined };

function isTaskStartedEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & TaskStartedEvent {
  return event.type === 'task_started';
}

function isTaskEndEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & (TaskCompletedEvent | TaskSkippedEvent) {
  return event.type === 'task_completed' || event.type === 'task_skipped';
}

function isDiffEvent<TEvent extends SectionableEvent>(event: TEvent): event is TEvent & DiffEvent {
  return event.type === 'implementer_generate_done';
}

export function diffEventKey(event: SectionableEvent): string {
  return `${event.type}:${event.ts ?? 0}`;
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
        return diffEventKey(event);
      }
    }
  }
  return null;
}

export type Section<TEvent extends SectionableEvent = SectionableEvent> =
  | { type: 'events'; items: TEvent[]; startIndex: number }
  | {
      type: 'completed-task';
      summary: {
        index: number;
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
  const taskRanges: {
    taskId: string;
    startIdx: number;
    endIdx: number;
    startEvent: TEvent & TaskStartedEvent;
    endEvent?: (TEvent & (TaskCompletedEvent | TaskSkippedEvent)) | undefined;
  }[] = [];
  const openTasks = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (isTaskStartedEvent(ev)) {
      const idx = taskRanges.length;
      taskRanges.push({ taskId: ev.taskId, startIdx: i, endIdx: -1, startEvent: ev });
      openTasks.set(ev.taskId, idx);
    } else if (isTaskEndEvent(ev)) {
      const rangeIdx = openTasks.get(ev.taskId);
      if (rangeIdx != null) {
        const range = taskRanges[rangeIdx];
        if (!range) continue;
        range.endIdx = i;
        range.endEvent = ev;
        openTasks.delete(ev.taskId);
      }
    }
  }

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

    if (range.endIdx >= 0 && range.endEvent) {
      const endEvent = range.endEvent;
      if (endEvent.type === 'task_completed') {
        sections.push({
          type: 'completed-task',
          summary: {
            index: range.startEvent.index + 1,
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
          summary: {
            index: range.startEvent.index + 1,
            title: range.startEvent.title,
            method: 'skipped',
            retries: 0,
            duration: 0,
            reason: endEvent.reason,
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
