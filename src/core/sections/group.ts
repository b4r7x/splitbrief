import { type SectionableEvent, opensReview } from './events.js';
import type { Section } from './types.js';
import { taskRangesOf } from './task-ranges.js';
import { settledStageSummary, reviewStage } from './stage-summary.js';
import {
  type ReviewCursor,
  countsAtCursor,
  pushLeadingBuildEvents,
  appendCompletedReviews,
} from './review-cursor.js';

export function groupEventsIntoSections<TEvent extends SectionableEvent>(
  events: TEvent[],
): Section<TEvent>[] {
  const taskRanges = taskRangesOf(events);

  const state: ReviewCursor<TEvent> = { events, sections: [], cursor: 0 };
  const { sections } = state;

  for (const range of taskRanges) {
    appendCompletedReviews(state, range.startIdx);
    if (state.cursor < range.startIdx) {
      const items = events.slice(state.cursor, range.startIdx);
      const summary = settledStageSummary(items, countsAtCursor(state, items));
      if (summary === null) {
        sections.push({ type: 'events', items, startIndex: state.cursor });
      } else {
        sections.push({ type: 'settled-stage', items, startIndex: state.cursor, summary });
      }
    }

    if (range.abandoned && range.endIdx >= range.startIdx) {
      sections.push({
        type: 'events',
        items: events.slice(range.startIdx, range.endIdx + 1),
        startIndex: range.startIdx,
      });
      state.cursor = range.endIdx + 1;
    } else if (range.endIdx >= 0 && range.endEvent) {
      const endEvent = range.endEvent;
      if (endEvent.type === 'task_completed') {
        sections.push({
          type: 'completed-task',
          items: events.slice(range.startIdx, range.endIdx + 1),
          startIndex: range.startIdx,
          summary: {
            id: range.taskId,
            title: range.startEvent.title,
            method: endEvent.method,
            retries: endEvent.retries,
            duration: endEvent.duration,
            ...(range.startEvent.file !== undefined && { file: range.startEvent.file }),
          },
        });
      } else if (endEvent.type === 'task_skipped') {
        sections.push({
          type: 'completed-task',
          items: events.slice(range.startIdx, range.endIdx + 1),
          startIndex: range.startIdx,
          summary: {
            id: range.taskId,
            title: range.startEvent.title,
            method: 'skipped',
            retries: 0,
            duration: 0,
            ...(range.startEvent.file !== undefined && { file: range.startEvent.file }),
            reason: endEvent.reason,
          },
        });
      } else if (endEvent.type === 'task_full_fail') {
        sections.push({
          type: 'completed-task',
          items: events.slice(range.startIdx, range.endIdx + 1),
          startIndex: range.startIdx,
          summary: {
            id: range.taskId,
            title: range.startEvent.title,
            method: 'failed',
            retries: 0,
            duration: 0,
            ...(range.startEvent.file !== undefined && { file: range.startEvent.file }),
          },
        });
      }
      state.cursor = range.endIdx + 1;
    } else {
      sections.push({
        type: 'active-task',
        items: events.slice(range.startIdx),
        startIndex: range.startIdx,
      });
      state.cursor = events.length;
      break;
    }
  }

  appendCompletedReviews(state, events.length);
  if (state.cursor < events.length) {
    pushLeadingBuildEvents(state);
    const items = events.slice(state.cursor);
    const summary = items.some(opensReview)
      ? settledStageSummary(items, countsAtCursor(state, items))
      : null;
    sections.push(
      summary?.stage === 'review'
        ? { type: 'settled-stage', items, startIndex: state.cursor, summary }
        : items.some(opensReview)
          ? {
              type: 'active-review',
              items,
              startIndex: state.cursor,
              review: reviewStage(items, countsAtCursor(state, items)),
            }
          : { type: 'events', items, startIndex: state.cursor },
    );
  }

  return sections;
}
