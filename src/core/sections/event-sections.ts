import { phaseStage } from '../rail-stages.js';
import type { Phase, TaskCompletionMethod } from '../schemas/enums.js';
import type { ReviewFindingCounts } from '../schemas/review.js';

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
};
type ChecksRunEvent = { type: 'checks_run'; results: { passed: boolean }[] };
type ReviewFixStartedEvent = { type: 'review_fix_started'; taskIds: string[] };
type ReviewCompletedEvent = {
  type: 'review_completed';
  scope: 'final' | 'task';
  afterTaskId?: string | undefined;
  verdict: 'pass' | 'pass-with-notes' | 'fail' | 'no-verdict' | 'stopped';
  findings?: ReviewFindingCounts | undefined;
  duration: number;
};
type WorkflowCompleteEvent = {
  type: 'workflow_complete';
  review?: 'passed' | 'failed' | undefined;
};

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

function isReviewCompletedEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & ReviewCompletedEvent {
  return event.type === 'review_completed';
}

// The diff's stable identity is its global render index, not its timestamp: publishers stamp events
// with `Date.now()`, so two diffs produced in the same millisecond would collide on a type+ts key and
// expand/collapse together. The global index is unique per rendered event and survives appends.
export function diffEventKey(event: SectionableEvent, globalIndex: number): string {
  return `${event.type}:${globalIndex}`;
}

export type StageSummary =
  | { stage: 'plan'; feature: string; duration: number }
  | {
      stage: 'review';
      scope: 'final' | 'task';
      afterTaskId?: string | undefined;
      /** The final review's fix cycles that came before this review. */
      fixCyclesBefore: number;
      /** The final reviews of this fix cycle that came before this one: a re-run, as after a crash. */
      rerunsBefore: number;
      outcome: 'passed' | 'passed-with-notes' | 'failed' | 'no-verdict' | 'stopped';
      findings?: ReviewCompletedEvent['findings'];
      failedCommands: string[];
      failedChecks: number;
      fixes: string[];
      duration: number;
    };

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
  | { type: 'active-task'; items: TEvent[]; startIndex: number };

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
      } else if (ev.type === 'task_skipped') {
        taskRanges.push({
          taskId: ev.taskId,
          startIdx: i,
          endIdx: i,
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
  let fixCycles = 0;
  let reruns = 0;
  const countFinalReview = (summary: StageSummary): void => {
    if (summary.stage !== 'review' || summary.scope !== 'final') return;
    if (summary.fixes.length === 0) {
      reruns++;
      return;
    }
    fixCycles++;
    reruns = 0;
  };

  function appendCompletedReviews(endIndex: number): void {
    let reviewStarted = false;
    for (let index = cursor; index < endIndex; index++) {
      const event = events[index];
      if (event === undefined) continue;
      if (event.type === 'review_started') reviewStarted = true;
      if (isReviewCompletedEvent(event)) reviewStarted = true;
      else if (reviewStarted || !(isWorkflowCompleteEvent(event) && event.review !== undefined))
        continue;
      let reviewEnd = index;
      for (let next = index + 1; next < endIndex; next++) {
        const following = events[next];
        if (following?.type === 'review_started' || following?.type === 'task_started') break;
        if (following?.type === 'review_fix_started') reviewEnd = next;
      }
      const items = events.slice(cursor, reviewEnd + 1);
      const summary = settledStageSummary(items, fixCycles, reruns);
      if (summary?.stage !== 'review') continue;
      sections.push({ type: 'settled-stage', items, startIndex: cursor, summary });
      countFinalReview(summary);
      cursor = reviewEnd + 1;
      index = reviewEnd;
    }
  }

  for (const range of taskRanges) {
    appendCompletedReviews(range.startIdx);
    if (cursor < range.startIdx) {
      const items = events.slice(cursor, range.startIdx);
      const summary = settledStageSummary(items, fixCycles, reruns);
      if (summary === null) {
        sections.push({ type: 'events', items, startIndex: cursor });
      } else {
        sections.push({ type: 'settled-stage', items, startIndex: cursor, summary });
        countFinalReview(summary);
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
    sections.push({ type: 'events', items: events.slice(cursor), startIndex: cursor });
  }

  return sections;
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

function settledStageSummary<TEvent extends SectionableEvent>(
  items: TEvent[],
  fixCyclesBefore: number,
  rerunsBefore: number,
): StageSummary | null {
  const stages = items.map((event) => (event.phase === undefined ? null : phaseStage(event.phase)));
  const completed = items.findLast(isReviewCompletedEvent);
  const reviewStarted = items.some((event) => event.type === 'review_started');
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
  const duration = firstTs === undefined || lastTs === undefined ? 0 : lastTs - firstTs;
  if (stage === 'plan') {
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
      failedChecks += event.results.filter((result) => result.passed === false).length;
    }
    if (isReviewFixStartedEvent(event)) fixes = event.taskIds;
  }
  const outcome = completed
    ? completed.verdict === 'pass'
      ? 'passed'
      : completed.verdict === 'pass-with-notes'
        ? 'passed-with-notes'
        : completed.verdict === 'fail'
          ? 'failed'
          : completed.verdict
    : reviewStarted
      ? null
      : (verdict ?? (fixes.length > 0 ? 'failed' : null));
  if (outcome === null) return null;
  return {
    stage,
    scope: completed?.scope ?? 'final',
    ...(completed?.afterTaskId !== undefined && { afterTaskId: completed.afterTaskId }),
    ...(completed?.findings !== undefined && { findings: completed.findings }),
    fixCyclesBefore,
    rerunsBefore,
    outcome,
    failedCommands: [...failedCommands],
    failedChecks,
    fixes,
    duration: completed ? completed.duration : duration,
  };
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
    const hasReviewStage = events
      .slice(gapStart, range.startIdx)
      .some(
        (event) =>
          event.type === 'review_started' ||
          (event.phase !== undefined && phaseStage(event.phase) === 'review'),
      );
    const consultIdx = events.findIndex(
      (event, idx) =>
        idx >= gapStart &&
        idx < range.startIdx &&
        event?.type === 'consult_answered' &&
        event.taskId === range.taskId,
    );
    const gapEnd = consultIdx >= 0 ? consultIdx : range.startIdx;
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
    if (consultIdx >= 0) {
      range.startIdx = consultIdx;
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
