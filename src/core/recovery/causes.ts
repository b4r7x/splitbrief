import { capitalize } from '../../utils/capitalize.js';
import { countNoun } from '../../utils/pluralize.js';
import { CREW_SEAT_LABELS } from '../crew/identity.js';
import type { SeatLineSpan } from '../crew/seat-line/collapse.js';
import { SOFT_SEP } from '../separators.js';

/** The review a halt names, in the transcript's words: a task review by the brief it judged. */
export function reviewName(
  review: Readonly<{ scope?: string | undefined; afterTaskId?: string | undefined }>,
): string {
  if (review.scope !== 'task') return 'Final review';
  return review.afterTaskId === undefined ? 'Task review' : `Review ${review.afterTaskId}`;
}

/** What tells final reviews apart: the fix cycles before one, and a re-run within one cycle. */
export function finalReviewAnchor(fixCycles: number, reruns: number): string | undefined {
  const parts = [
    ...(fixCycles > 0 ? [`after ${countNoun(fixCycles, 'fix cycle')}`] : []),
    ...(reruns > 0 ? [reruns === 1 ? 're-run' : `re-run ${reruns}`] : []),
  ];
  return parts.length === 0 ? undefined : parts.join(', ');
}

/** A review that judged its scope and found blockers, in the one wording every surface shares. */
export function reviewFailedCause(review: string, blocking: number): string {
  return `${review} failed with ${countNoun(blocking, 'blocking finding')}`;
}

/**
 * A review round that moved nothing: the answer fixed none of its blockers, or a fix cycle left
 * the same blockers. Names at most three of them.
 */
export function reviewNoProgressCause(
  review: string,
  blockers: readonly string[],
  fixCycle?: number,
): string {
  const shown = blockers.slice(0, 3).join(', ');
  const ids = blockers.length > 3 ? `${shown} +${blockers.length - 3} more` : shown;
  return fixCycle === undefined
    ? `${review} found no fix for ${ids}`
    : `${review} made no progress on ${ids} after fix cycle ${fixCycle}`;
}

/** The criteria no check verified, in the one wording the halt and the review row share. */
export function unverifiedCriteriaCount(count: number): string {
  return countNoun(count, 'unverified criterion', 'unverified criteria');
}

/** A review that failed on claims no check could verify, with nothing for the planner to fix. */
export function reviewUnverifiedCause(review: string, criteria: number): string {
  return `${review} failed with ${unverifiedCriteriaCount(criteria)}`;
}

/**
 * A review whose only failures are render criteria its seat could not see: it names the seat to
 * change in place of the unverified count.
 */
export function reviewSeatNoImagesCause(review: string): readonly SeatLineSpan[] {
  return [
    { text: `${review} needs a ` },
    { text: CREW_SEAT_LABELS.review, seat: 'review' },
    { text: ' seat that reads images' },
  ];
}

/** What stopped a retry-exhausted brief, in the one wording the transcript, the panel and the byline share. */
export function retryExhaustedCause(
  cause: Readonly<{
    task: string;
    plannerVerdict?: string | undefined;
    hookReason?: string | undefined;
    question?: string | undefined;
    /** The runner that answered the brief cannot be done: `planner` or `reviewer`. */
    cannotBy?: string | undefined;
  }>,
): string {
  if (cause.plannerVerdict === 'brief') return `${cause.task}: the planner found the brief wrong`;
  if (cause.hookReason !== undefined) {
    return `${cause.task} escalation blocked by pre_escalation hook: ${cause.hookReason}`;
  }
  if (cause.question !== undefined) return `${cause.task} needs your answer`;
  if (cause.cannotBy !== undefined)
    return `${cause.task}: the ${cause.cannotBy} says it cannot be done`;
  return `${cause.task} failed`;
}

/** The reason a runner gave for a brief that cannot be done, in the words the panel and the headless line share. */
export function cannotDetail(by: string, reason: string): string {
  return `${capitalize(by)} said: ${reason}`;
}

/** What a halt of the planning phase says while a plan correction stands on the run. */
export const PLAN_CORRECTION_GOES_AGAIN = 'Your plan correction goes again with this step.';

/**
 * The line the halt asks the user to read: the planner's question, why it cannot be done, or the
 * plan correction that goes again.
 */
export function isAskedDetail(detail: string): boolean {
  return (
    detail.startsWith('Question: ') ||
    detail.startsWith('Planner said: ') ||
    detail.startsWith(PLAN_CORRECTION_GOES_AGAIN)
  );
}

/** A repository change under a brief, with the changes the audit saw, in the words every surface shares. */
export function repositoryChangedCause(task: string, changes: string | undefined): string {
  const lead = `Repository changed under ${task}`;
  return changes === undefined ? lead : `${lead}${SOFT_SEP}${changes}`;
}

/** A brief whose tool call named a path outside the run's isolation directory. */
export function leftIsolationCause(task: string): string {
  return `${task} left the isolation directory`;
}
