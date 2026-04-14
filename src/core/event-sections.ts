import type { TuiEvent, TaskCompletionMethod } from './types/index.js';

export type Section =
  | { type: 'events'; items: TuiEvent[]; startIndex: number }
  | { type: 'completed-task'; summary: { index: number; title: string; method: TaskCompletionMethod; retries: number; duration: number; file?: string; reason?: string } }
  | { type: 'active-task'; items: TuiEvent[]; startIndex: number };

export function groupEventsIntoSections(events: TuiEvent[]): Section[] {
  const taskRanges: { taskId: string; startIdx: number; endIdx: number; startEvent: TuiEvent & { type: 'task-start' }; endEvent?: TuiEvent }[] = [];
  const openTasks = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (ev.type === 'task-start') {
      const idx = taskRanges.length;
      taskRanges.push({ taskId: ev.taskId, startIdx: i, endIdx: -1, startEvent: ev });
      openTasks.set(ev.taskId, idx);
    } else if (ev.type === 'task-complete' || ev.type === 'task-skipped') {
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

  const sections: Section[] = [];
  let cursor = 0;

  for (const range of taskRanges) {
    if (cursor < range.startIdx) {
      sections.push({ type: 'events', items: events.slice(cursor, range.startIdx), startIndex: cursor });
    }

    if (range.endIdx >= 0 && range.endEvent) {
      const endEvent = range.endEvent;
      if (endEvent.type === 'task-complete') {
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
      } else if (endEvent.type === 'task-skipped') {
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
