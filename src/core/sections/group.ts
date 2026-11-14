import { phaseStage } from '../phases/rail.js';
import {
  type SectionableEvent,
  isTaskStartedEvent,
  isTaskResetEvent,
  isTaskEndEvent,
  opensReview,
  isReviewFixStartedEvent,
  isReviewStartedEvent,
  isReviewCompletedEvent,
  isReviewedCompleteEvent,
} from './events.js';
import type { Section, ReviewCounts } from './types.js';
import { abandonOpenTask, joinBuildRowsToBriefs } from './task-ranges.js';
import { outcomeEnd } from './task-ranges.js';
import type { TaskRange } from './task-ranges.js';
import { settledStageSummary, reviewStage } from './stage-summary.js';

export function groupEventsIntoSections<TEvent extends SectionableEvent>(
  events: TEvent[],
): Section<TEvent>[] {
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

  const sections: Section<TEvent>[] = [];
  let cursor = 0;

  // A review follows the last cycle the engine recorded before it opened; a final review before it
  // after the same cycle was a re-run.
  function countsAtCursor(items: TEvent[]): ReviewCounts {
    const opened = cursor + Math.max(0, items.findIndex(opensReview));
    const fixCyclesBefore = events.slice(0, opened).findLast(isReviewFixStartedEvent)?.cycle ?? 0;
    const rerunsBefore = sections.filter(
      (section) =>
        section.type === 'settled-stage' &&
        section.summary.stage === 'review' &&
        section.summary.scope === 'final' &&
        section.summary.fixCyclesBefore === fixCyclesBefore,
    ).length;
    return { fixCyclesBefore, rerunsBefore };
  }

  function pushLeadingBuildEvents(endIndex = events.length): void {
    const opener = events.findIndex(
      (event, index) => index >= cursor && index < endIndex && opensReview(event),
    );
    const openerPhase = events[opener]?.phase;
    if (opener < 0 || openerPhase === undefined || phaseStage(openerPhase) !== 'review') return;
    let split = cursor;
    while (split < endIndex) {
      const event = events[split];
      if (
        event === undefined ||
        event.phase === undefined ||
        phaseStage(event.phase) !== 'build' ||
        opensReview(event)
      ) {
        break;
      }
      split++;
    }
    if (split > cursor) {
      sections.push({ type: 'events', items: events.slice(cursor, split), startIndex: cursor });
      cursor = split;
    }
  }

  function appendCompletedReviews(endIndex: number): void {
    let reviewStarted = false;
    for (let index = cursor; index < endIndex; index++) {
      const event = events[index];
      if (event === undefined) continue;
      if (
        event.type === 'workflow_resumed' &&
        (reviewStarted || (event.phase !== undefined && phaseStage(event.phase) === 'review'))
      ) {
        pushLeadingBuildEvents(index);
        const items = events.slice(cursor, index);
        const summary = items.some(opensReview)
          ? settledStageSummary(items, countsAtCursor(items), true)
          : null;
        if (items.length > 0) {
          if (summary?.stage === 'review') {
            sections.push({ type: 'settled-stage', items, startIndex: cursor, summary });
          } else {
            sections.push({ type: 'events', items, startIndex: cursor });
          }
        }
        sections.push({ type: 'events', items: [event], startIndex: index });
        cursor = index + 1;
        reviewStarted = false;
        continue;
      }
      if (isReviewStartedEvent(event)) reviewStarted = true;
      if (isReviewCompletedEvent(event)) reviewStarted = true;
      else if (reviewStarted || !isReviewedCompleteEvent(event)) continue;
      // The review owns the fix cycle it starts; a cycle after the run completed is Apply's.
      let reviewEnd = index;
      for (let next = index + 1; next < endIndex; next++) {
        const following = events[next];
        if (
          following?.type === 'review_started' ||
          following?.type === 'task_started' ||
          following?.type === 'workflow_resumed' ||
          following?.type === 'workflow_complete'
        )
          break;
        if (following?.type === 'review_fix_started') reviewEnd = next;
      }
      pushLeadingBuildEvents(reviewEnd + 1);
      const items = events.slice(cursor, reviewEnd + 1);
      const summary = settledStageSummary(items, countsAtCursor(items));
      if (summary?.stage !== 'review') continue;
      sections.push({ type: 'settled-stage', items, startIndex: cursor, summary });
      cursor = reviewEnd + 1;
      index = reviewEnd;
    }
  }

  for (const range of taskRanges) {
    appendCompletedReviews(range.startIdx);
    if (cursor < range.startIdx) {
      const items = events.slice(cursor, range.startIdx);
      const summary = settledStageSummary(items, countsAtCursor(items));
      if (summary === null) {
        sections.push({ type: 'events', items, startIndex: cursor });
      } else {
        sections.push({ type: 'settled-stage', items, startIndex: cursor, summary });
      }
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

  appendCompletedReviews(events.length);
  if (cursor < events.length) {
    pushLeadingBuildEvents();
    const items = events.slice(cursor);
    const summary = items.some(opensReview)
      ? settledStageSummary(items, countsAtCursor(items))
      : null;
    sections.push(
      summary?.stage === 'review'
        ? { type: 'settled-stage', items, startIndex: cursor, summary }
        : items.some(opensReview)
          ? {
              type: 'active-review',
              items,
              startIndex: cursor,
              review: reviewStage(items, countsAtCursor(items)),
            }
          : { type: 'events', items, startIndex: cursor },
    );
  }

  return sections;
}
