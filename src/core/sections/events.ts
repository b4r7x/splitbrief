import { phaseStage } from '../phases/rail.js';
import type { Phase, TaskCompletionMethod } from '../schemas/enums.js';
import type { ReviewFindingCounts } from '../schemas/review/verdict.js';
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
export type TaskEndEvent = TaskCompletedEvent | TaskSkippedEvent | TaskFullFailEvent;
type WorkflowStartedEvent = { type: 'workflow_started'; feature: string };
type FullSuiteEvent = {
  type: 'full_suite';
  status: 'running' | 'done' | 'not-run' | 'refused' | 'stopped' | 'off';
  id?: string;
  command: string;
  moment: 'pre-review' | 'base' | 'brief' | 'plan' | 'verify';
  passed?: boolean;
  newFailures?: number;
  notVerified?: number;
  duration?: number;
};
type ChecksRunEvent = { type: 'checks_run'; results: { status: CheckStatus }[] };
type ReviewFixStartedEvent = { type: 'review_fix_started'; cycle: number; taskIds: string[] };
export type ReviewCompletedEvent = {
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
  review?: 'passed' | 'failed' | 'none' | undefined;
};
type WorkflowCancelledEvent = { type: 'workflow_cancelled'; atRestFrom?: number | undefined };

export function isTaskStartedEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & TaskStartedEvent {
  return event.type === 'task_started';
}

export function isTaskEndEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & TaskEndEvent {
  return (
    event.type === 'task_completed' ||
    event.type === 'task_skipped' ||
    event.type === 'task_full_fail'
  );
}

export function isTaskResetEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & TaskResetEvent {
  return event.type === 'task_reset';
}

export function isWorkflowStartedEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & WorkflowStartedEvent {
  return event.type === 'workflow_started';
}

export function isFullSuiteEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & FullSuiteEvent {
  return event.type === 'full_suite';
}

export function isChecksRunEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & ChecksRunEvent {
  return event.type === 'checks_run';
}

export function isReviewFixStartedEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & ReviewFixStartedEvent {
  return event.type === 'review_fix_started';
}

function isWorkflowCompleteEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & WorkflowCompleteEvent {
  return event.type === 'workflow_complete';
}

/** A run's end that carries a review outcome: REVIEW None ends with no review to show a stage for. */
export function isReviewedCompleteEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & WorkflowCompleteEvent & { review: 'passed' | 'failed' } {
  return isWorkflowCompleteEvent(event) && event.review !== undefined && event.review !== 'none';
}

export function isWorkflowCancelledEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & WorkflowCancelledEvent {
  return event.type === 'workflow_cancelled';
}

export function isReviewCompletedEvent<TEvent extends SectionableEvent>(
  event: TEvent,
): event is TEvent & ReviewCompletedEvent {
  return event.type === 'review_completed';
}

export function isReviewStartedEvent<TEvent extends SectionableEvent>(
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

// A review opens at its start or at the first check it runs: the plan checks run in the review
// phase before the review call starts. A base re-run runs beside the build and opens nothing.
export function opensReview(event: SectionableEvent): boolean {
  return (
    isReviewStartedEvent(event) ||
    (((isFullSuiteEvent(event) && event.moment !== 'base') || isChecksRunEvent(event)) &&
      event.phase !== undefined &&
      phaseStage(event.phase) === 'review')
  );
}
