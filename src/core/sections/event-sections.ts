import { isProcessWentAwayMark } from '../event-phase.js';
import { endBeforeAtRest } from '../sessions/at-rest-end.js';
import { phaseStage } from '../rail-stages.js';
import type { Phase, TaskCompletionMethod } from '../schemas/enums.js';
import type { ReviewFindingCounts } from '../schemas/review.js';
import type { CheckStatus } from '../schemas/task.js';

export interface SectionableEvent {
  type: string;
  ts?: number;
  phase?: Phase;
  taskId?: string | null | undefined;
}

type TaskStartedEvent = {
  type: 'task_started';
  taskId: string;
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
type TaskSkippedEvent = { type: 'task_skipped'; taskId: string; title: string; reason: string };
type TaskFullFailEvent = { type: 'task_full_fail'; taskId: string };
type TaskResetEvent = { type: 'task_reset'; taskId: string };
type TaskEndEvent = TaskCompletedEvent | TaskSkippedEvent | TaskFullFailEvent;
type WorkflowStartedEvent = { type: 'workflow_started'; feature: string };
type FullSuiteEvent = {
  type: 'full_suite';
  status: 'running' | 'done' | 'not-run' | 'refused' | 'stopped';
  id?: string;
  command: string;
  moment: 'pre-review' | 'base' | 'brief' | 'plan';
  passed?: boolean;
  newFailures?: number;
  notVerified?: number;
  duration?: number;
};
type ChecksRunEvent = { type: 'checks_run'; results: { status: CheckStatus }[] };
type ReviewFixStartedEvent = { type: 'review_fix_started'; cycle: number; taskIds: string[] };
type ReviewCompletedEvent = {
  type: 'review_completed';
  scope: 'final' | 'task';
  afterTaskId?: string | undefined;
  verdict: 'pass' | 'pass-with-notes' | 'fail' | 'no-verdict' | 'stopped';
  findings?: ReviewFindingCounts | undefined;
  duration: number;
};
type ReviewStartedEvent = Pick<ReviewCompletedEvent, 'scope' | 'afterTaskId'> & {
  type: 'review_started';
};
type WorkflowCompleteEvent = {
  type: 'workflow_complete';
  review?: 'passed' | 'failed' | undefined;
};
type WorkflowCancelledEvent = { type: 'workflow_cancelled'; atRestFrom?: number | undefined };

interface TaskRange<TEvent extends SectionableEvent> {
  taskId: string;
  startIdx: number;
  endIdx: number;
  startEvent: { title: string; file?: string | undefined };
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

function isWorkflowStartedEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & WorkflowStartedEvent {
  return event.type === 'workflow_started';
}

function isFullSuiteEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & FullSuiteEvent {
  return event.type === 'full_suite';
}

function isChecksRunEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & ChecksRunEvent {
  return event.type === 'checks_run';
}

function isReviewFixStartedEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & ReviewFixStartedEvent {
  return event.type === 'review_fix_started';
}

function isWorkflowCompleteEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & WorkflowCompleteEvent {
  return event.type === 'workflow_complete';
}

function isWorkflowCancelledEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & WorkflowCancelledEvent {
  return event.type === 'workflow_cancelled';
}

function isReviewCompletedEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & ReviewCompletedEvent {
  return event.type === 'review_completed';
}

function isReviewStartedEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & ReviewStartedEvent {
  return event.type === 'review_started';
}

// The diff's stable identity is its global render index, not its timestamp: publishers stamp events
// with `Date.now()`, so two diffs produced in the same millisecond would collide on a type+ts key and
// expand/collapse together. The global index is unique per rendered event and survives appends.
export function diffEventKey(event: SectionableEvent, globalIndex: number): string {
  return `${event.type}:${globalIndex}`;
}

/** What names a review stage: its scope, the brief a task review follows, and the cycles before it. */
export interface ReviewStage {
  stage: 'review';
  scope: 'final' | 'task';
  afterTaskId?: string | undefined;
  /** The run's fix cycles before this review, task reviews included: the count the stage anchor shows. */
  fixCyclesBefore: number;
  /** The final reviews of this fix cycle that came before this one: a re-run, as after a crash. */
  rerunsBefore: number;
}

type ReviewCounts = Pick<ReviewStage, 'fixCyclesBefore' | 'rerunsBefore'>;

export type StageSummary =
  | { stage: 'plan'; feature: string; duration: number }
  | (ReviewStage & {
      outcome: 'passed' | 'passed-with-notes' | 'failed' | 'no-verdict' | 'stopped';
      findings?: ReviewCompletedEvent['findings'];
      failedCommands: string[];
      failedChecks: number;
      fixes: string[];
      duration: number;
      /** A process exit cut its call: `duration` runs only to the last thing the call reported. */
      endUnknown?: true;
    });

export type Section<TEvent extends SectionableEvent = SectionableEvent> =
  | { type: 'events'; items: TEvent[]; startIndex: number }
  | { type: 'settled-stage'; items: TEvent[]; startIndex: number; summary: StageSummary }
  | {
      type: 'completed-task';
      items: TEvent[];
      startIndex: number;
      summary: {
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
  | { type: 'active-task'; items: TEvent[]; startIndex: number }
  | { type: 'active-review'; items: TEvent[]; startIndex: number; review: ReviewStage };

export function isSettledSection<TEvent extends SectionableEvent>(
  section: Section<TEvent>,
): section is Extract<Section<TEvent>, { type: 'completed-task' | 'settled-stage' }> {
  return section.type === 'completed-task' || section.type === 'settled-stage';
}

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
      else if (reviewStarted || !(isWorkflowCompleteEvent(event) && event.review !== undefined))
        continue;
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

// A review opens at its start or at the first check it runs: the plan checks run in the review
// phase before the review call starts.
function opensReview(event: SectionableEvent): boolean {
  return (
    isReviewStartedEvent(event) ||
    ((isFullSuiteEvent(event) || isChecksRunEvent(event)) &&
      event.phase !== undefined &&
      phaseStage(event.phase) === 'review')
  );
}

function reviewStage<TEvent extends SectionableEvent>(
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

function settledStageSummary<TEvent extends SectionableEvent>(
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
      : items.findLast(isWorkflowCompleteEvent)?.review;
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
  // A red pre-review command counts as failed. A red base re-run with zero new failures and none
  // not verified at the run base removes it because every failure is pre-existing and the run
  // continued. Older base rows keep the count.
  for (const event of items) {
    if (isFullSuiteEvent(event) && event.status === 'done' && event.passed === false) {
      if (event.moment === 'pre-review') failedCommands.add(event.command);
      if (
        event.moment === 'base' &&
        event.newFailures === 0 &&
        (event.notVerified === undefined || event.notVerified === 0)
      ) {
        failedCommands.delete(event.command);
      }
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
