import type { TuiEvent, TaskCompletionMethod } from '../types.js';
import { assertNever } from '../utils/type-guards.js';

export type Section =
  | { type: 'events'; items: TuiEvent[]; startIndex: number }
  | { type: 'completed-task'; summary: { index: number; title: string; method: TaskCompletionMethod; retries: number; duration: number; file?: string; reason?: string } }
  | { type: 'active-task'; items: TuiEvent[]; startIndex: number };

export function groupEventsIntoSections(events: TuiEvent[]): Section[] {
  const taskRanges: { taskId: string; startIdx: number; endIdx: number; startEvent: TuiEvent & { type: 'task-start' }; endEvent?: TuiEvent }[] = [];
  const openTasks = new Map<string, number>();

  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    if (ev.type === 'task-start') {
      const idx = taskRanges.length;
      taskRanges.push({ taskId: ev.taskId, startIdx: i, endIdx: -1, startEvent: ev });
      openTasks.set(ev.taskId, idx);
    } else if (ev.type === 'task-complete' || ev.type === 'task-skipped') {
      const rangeIdx = openTasks.get(ev.taskId);
      if (rangeIdx != null) {
        taskRanges[rangeIdx]!.endIdx = i;
        taskRanges[rangeIdx]!.endEvent = ev;
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

function estimateEventHeight(event: TuiEvent, diffExpanded?: boolean): number {
  switch (event.type) {
    case 'planner-status':
      return 3;
    case 'planner-text':
      return Math.max(3, event.text.split('\n').length + 2);
    case 'task-start':
      return 4;
    case 'task-complete':
    case 'task-skipped':
      return 1;
    case 'implementer-generate-running':
      return 3;
    case 'implementer-generate-done':
      return diffExpanded ? 6 : 4;
    case 'implementer-generate-failed':
      return 3;
    case 'validate':
      if (event.status === 'running') return 3;
      return event.error ? 5 : 4;
    case 'retry':
      return 3;
    case 'escalate':
      return event.hint ? 4 : 3;
    case 'git-commit':
    case 'git-checkpoint':
      return 3;
    case 'warning':
    case 'error':
      return 3;
    case 'cost-update':
      return 1;
    case 'cost-prediction':
      return 5;
    case 'budget-warning':
    case 'budget-exceeded':
      return 3;
    case 'workflow-cancelled':
      return 3;
    case 'workflow-config':
      return 3;
    default:
      return assertNever(event);
  }
}

export function estimateSectionHeight(section: Section, expandedDiffs: Set<number>): number {
  if (section.type === 'completed-task') return 1;
  return section.items.reduce(
    (sum, ev, i) => sum + estimateEventHeight(ev, expandedDiffs.has(section.startIndex + i)),
    0,
  );
}

export function findLatestDiffEventIndex(events: TuiEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === 'implementer-generate-done' && ev.diff) {
      return i;
    }
  }
  return null;
}
