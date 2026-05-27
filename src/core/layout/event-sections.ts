import type { TaskCompletionMethod } from '../schemas/enums.js';
import type { LayoutEvent } from './event-types.js';

export function findLatestRenderableDiffEventIndex<TEvent extends LayoutEvent>(sections: Section<TEvent>[]): number | null {
  for (let sectionIndex = sections.length - 1; sectionIndex >= 0; sectionIndex--) {
    const section = sections[sectionIndex];
    if (!section || section.type === 'completed-task') continue;
    for (let index = section.items.length - 1; index >= 0; index--) {
      const event = section.items[index];
      if (!event) continue;
      if (event.type === 'implementer_generate_done' && event.diff) {
        return section.startIndex + index;
      }
    }
  }
  return null;
}

export type Section<TEvent extends LayoutEvent = LayoutEvent> =
  | { type: 'events'; items: TEvent[]; startIndex: number }
  | { type: 'completed-task'; summary: { index: number; title: string; method: TaskCompletionMethod; retries: number; duration: number; file?: string; reason?: string } }
  | { type: 'active-task'; items: TEvent[]; startIndex: number };

export type DynamicSection<TEvent extends LayoutEvent = LayoutEvent> = Extract<Section<TEvent>, { type: 'events' | 'active-task' }>;

type TaskStartedLayoutEvent<TEvent extends LayoutEvent> = Extract<TEvent, { type: 'task_started' }>;
type TaskEndLayoutEvent<TEvent extends LayoutEvent> = Extract<TEvent, { type: 'task_completed' | 'task_skipped' }>;

function isTaskStartedEvent<TEvent extends LayoutEvent>(event: TEvent): event is TaskStartedLayoutEvent<TEvent> {
  return event.type === 'task_started';
}

function isTaskEndEvent<TEvent extends LayoutEvent>(event: TEvent): event is TaskEndLayoutEvent<TEvent> {
  return event.type === 'task_completed' || event.type === 'task_skipped';
}

export function groupEventsIntoSections<TEvent extends LayoutEvent>(events: TEvent[]): Section<TEvent>[] {
  const taskRanges: {
    taskId: string;
    startIdx: number;
    endIdx: number;
    startEvent: TaskStartedLayoutEvent<TEvent>;
    endEvent?: TaskEndLayoutEvent<TEvent> | undefined;
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
      sections.push({ type: 'events', items: events.slice(cursor, range.startIdx), startIndex: cursor });
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
            duration: Math.round(endEvent.duration / 1000),
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
      sections.push({ type: 'active-task', items: events.slice(range.startIdx), startIndex: range.startIdx });
      cursor = events.length;
      break;
    }
  }

  if (cursor < events.length) {
    sections.push({ type: 'events', items: events.slice(cursor), startIndex: cursor });
  }

  return sections;
}
