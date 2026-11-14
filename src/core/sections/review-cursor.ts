import { phaseStage } from '../phases/rail.js';
import {
  type SectionableEvent,
  opensReview,
  isReviewFixStartedEvent,
  isReviewStartedEvent,
  isReviewCompletedEvent,
  isReviewedCompleteEvent,
} from './events.js';
import type { Section, ReviewCounts } from './types.js';
import { settledStageSummary } from './stage-summary.js';

/** The sections grouped so far, and `cursor`: the first event that no section holds yet. */
export interface ReviewCursor<TEvent extends SectionableEvent> {
  readonly events: TEvent[];
  readonly sections: Section<TEvent>[];
  cursor: number;
}

// A review follows the last cycle the engine recorded before it opened; a final review before it
// after the same cycle was a re-run.
export function countsAtCursor<TEvent extends SectionableEvent>(
  state: ReviewCursor<TEvent>,
  items: TEvent[],
): ReviewCounts {
  const opened = state.cursor + Math.max(0, items.findIndex(opensReview));
  const fixCyclesBefore =
    state.events.slice(0, opened).findLast(isReviewFixStartedEvent)?.cycle ?? 0;
  const rerunsBefore = state.sections.filter(
    (section) =>
      section.type === 'settled-stage' &&
      section.summary.stage === 'review' &&
      section.summary.scope === 'final' &&
      section.summary.fixCyclesBefore === fixCyclesBefore,
  ).length;
  return { fixCyclesBefore, rerunsBefore };
}

export function pushLeadingBuildEvents<TEvent extends SectionableEvent>(
  state: ReviewCursor<TEvent>,
  endIndex = state.events.length,
): void {
  const { events } = state;
  const opener = events.findIndex(
    (event, index) => index >= state.cursor && index < endIndex && opensReview(event),
  );
  const openerPhase = events[opener]?.phase;
  if (opener < 0 || openerPhase === undefined || phaseStage(openerPhase) !== 'review') return;
  let split = state.cursor;
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
  if (split > state.cursor) {
    state.sections.push({
      type: 'events',
      items: events.slice(state.cursor, split),
      startIndex: state.cursor,
    });
    state.cursor = split;
  }
}

export function appendCompletedReviews<TEvent extends SectionableEvent>(
  state: ReviewCursor<TEvent>,
  endIndex: number,
): void {
  const { events, sections } = state;
  let reviewStarted = false;
  for (let index = state.cursor; index < endIndex; index++) {
    const event = events[index];
    if (event === undefined) continue;
    if (
      event.type === 'workflow_resumed' &&
      (reviewStarted || (event.phase !== undefined && phaseStage(event.phase) === 'review'))
    ) {
      pushLeadingBuildEvents(state, index);
      const items = events.slice(state.cursor, index);
      const summary = items.some(opensReview)
        ? settledStageSummary(items, countsAtCursor(state, items), true)
        : null;
      if (items.length > 0) {
        if (summary?.stage === 'review') {
          sections.push({ type: 'settled-stage', items, startIndex: state.cursor, summary });
        } else {
          sections.push({ type: 'events', items, startIndex: state.cursor });
        }
      }
      sections.push({ type: 'events', items: [event], startIndex: index });
      state.cursor = index + 1;
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
    pushLeadingBuildEvents(state, reviewEnd + 1);
    const items = events.slice(state.cursor, reviewEnd + 1);
    const summary = settledStageSummary(items, countsAtCursor(state, items));
    if (summary?.stage !== 'review') continue;
    sections.push({ type: 'settled-stage', items, startIndex: state.cursor, summary });
    state.cursor = reviewEnd + 1;
    index = reviewEnd;
  }
}
