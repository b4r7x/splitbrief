import { isProcessWentAwayMark } from '../phases/of-event.js';
import { phaseStage } from '../phases/rail.js';
import { endBeforeAtRest } from '../sessions/at-rest-end.js';
import {
  type SectionableEvent,
  isReviewCompletedEvent,
  isReviewStartedEvent,
  isReviewedCompleteEvent,
  isWorkflowStartedEvent,
  isFullSuiteEvent,
  isChecksRunEvent,
  isReviewFixStartedEvent,
  opensReview,
  isWorkflowCancelledEvent,
} from './events.js';
import type { ReviewCounts, ReviewStage, StageSummary } from './types.js';

export function reviewStage<TEvent extends SectionableEvent>(
  items: TEvent[],
  counts: ReviewCounts,
): ReviewStage {
  const completed = items.findLast(isReviewCompletedEvent);
  const started = items.findLast(isReviewStartedEvent);
  const afterTaskId = completed?.afterTaskId ?? started?.afterTaskId;
  return {
    stage: 'review',
    scope: completed?.scope ?? started?.scope ?? 'final',
    ...(afterTaskId !== undefined && { afterTaskId }),
    ...counts,
  };
}

export function settledStageSummary<TEvent extends SectionableEvent>(
  items: TEvent[],
  counts: ReviewCounts,
  resumed = false,
): StageSummary | null {
  const stages = items.map((event) => (event.phase === undefined ? null : phaseStage(event.phase)));
  const completed = items.findLast(isReviewCompletedEvent);
  const reviewStarted = items.findLast(isReviewStartedEvent);
  const verdict =
    reviewStarted || completed !== undefined
      ? undefined
      : items.findLast(isReviewedCompleteEvent)?.review;
  const stage =
    completed !== undefined || reviewStarted || verdict !== undefined || stages.includes('review')
      ? 'review'
      : stages.includes('plan')
        ? 'plan'
        : null;
  if (stage === null) return null;

  let firstTs: number | undefined;
  let lastTs: number | undefined;
  for (const event of items) {
    if (event.ts === undefined) continue;
    firstTs ??= event.ts;
    lastTs = event.ts;
  }
  if (stage === 'plan') {
    const duration = firstTs === undefined || lastTs === undefined ? 0 : lastTs - firstTs;
    return { stage, feature: items.find(isWorkflowStartedEvent)?.feature ?? '', duration };
  }

  const failedCommands = new Set<string>();
  let failedChecks = 0;
  let fixes: string[] = [];
  // A red pre-review command counts as failed, unless its split finds zero new failures and none
  // not verified at the run base: every failure is pre-existing and the run continued. In an older
  // run the base re-run carried that split and removed the count.
  for (const event of items) {
    if (isFullSuiteEvent(event) && event.status === 'done' && event.passed === false) {
      const allPreExisting =
        event.newFailures === 0 && (event.notVerified === undefined || event.notVerified === 0);
      if (event.moment === 'pre-review' && !allPreExisting) failedCommands.add(event.command);
      if (event.moment === 'base' && allPreExisting) failedCommands.delete(event.command);
    }
    if (isChecksRunEvent(event)) {
      failedChecks += event.results.filter((result) => result.status === 'fail').length;
    }
    if (isReviewFixStartedEvent(event)) fixes = event.taskIds;
  }
  // A stop before the review opened — at its start, or before one at the first check it runs —
  // parked the run before it; a review call that starts after the stop is the cut call continued
  // in place.
  const openIndex = reviewStarted
    ? items.findLastIndex(isReviewStartedEvent)
    : items.findIndex(opensReview);
  const stopIndex =
    openIndex < 0
      ? -1
      : items.findLastIndex(
          (event, index) =>
            index > openIndex &&
            (event.type === 'turn_interrupted' ||
              event.type === 'workflow_cancelled' ||
              isProcessWentAwayMark(event) ||
              (event.type === 'runner_call_activity' &&
                'kind' in event &&
                event.kind === 'error' &&
                'role' in event &&
                event.role === 'review' &&
                'stage' in event &&
                event.stage === 'aborted')),
        );
  // The clock runs from the start of what opened the review to its last mark. A finished check's row
  // carries the time it ended, so it started `duration` before it. An End taken at rest ends the
  // clock before the time the run sat at rest.
  const opener = items[openIndex];
  const startTs =
    opener?.ts === undefined
      ? firstTs
      : isFullSuiteEvent(opener) && opener.status === 'done'
        ? opener.ts - (opener.duration ?? 0)
        : opener.ts;
  const atRestFrom = items.findLast(isWorkflowCancelledEvent)?.atRestFrom;
  const endTs =
    atRestFrom === undefined || startTs === undefined
      ? lastTs
      : endBeforeAtRest(items.slice(Math.max(0, openIndex)), atRestFrom, startTs);
  const duration = startTs === undefined || endTs === undefined ? 0 : endTs - startTs;
  const stopped =
    stopIndex >= 0 &&
    !items
      .slice(stopIndex + 1)
      .some(
        (event) =>
          event.type === 'runner_call_started' && 'role' in event && event.role === 'review',
      );
  const outcome = completed
    ? completed.verdict === 'pass'
      ? 'passed'
      : completed.verdict === 'pass-with-notes'
        ? 'passed-with-notes'
        : completed.verdict === 'fail'
          ? 'failed'
          : completed.verdict
    : reviewStarted
      ? resumed || stopped
        ? 'stopped'
        : null
      : (verdict ?? (fixes.length > 0 ? 'failed' : resumed || stopped ? 'stopped' : null));
  if (outcome === null) return null;
  return {
    ...reviewStage(items, counts),
    ...(completed?.findings !== undefined && { findings: completed.findings }),
    outcome,
    failedCommands: [...failedCommands],
    failedChecks,
    fixes,
    duration: completed ? completed.duration : duration,
    ...(outcome === 'stopped' &&
      items.some(
        (event) =>
          event.type === 'runner_call_activity' &&
          'role' in event &&
          event.role === 'review' &&
          'endUnknown' in event &&
          event.endUnknown === true,
      ) && { endUnknown: true }),
  };
}
