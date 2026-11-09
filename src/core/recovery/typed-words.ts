import type { RecoveryAction, RecoveryReason } from '../schemas/enums.js';
import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import type { StepRef } from '../schemas/run-step.js';
import type { RunStatus } from '../sessions/run-status.js';

/** Whether a step reads no words typed for it: Apply never does, and under REVIEW None no review does, as no seat runs it. */
export function stepReadsNoWords(step: StepRef, reviewNone: boolean): boolean {
  return step.kind === 'apply' || (reviewNone && step.kind === 'review');
}

/**
 * Whether words typed with this action on this halt reach no step that reads them. End run reads
 * no words and asks for none. Accept as is keeps them only as the note of a review skipped as too
 * large; on a failed review only Apply would read that note, and a checkout run closes without
 * Apply. Re-run Apply and Restore backup run Apply, which reads none. Every other action hands
 * them to the step the run picks up at, and `stepReadsNone` says when that step reads none.
 */
export function leavesWordsUnread(
  reason: RecoveryReason,
  action: RecoveryAction,
  stepReadsNone: boolean,
): boolean {
  switch (action) {
    case 'end-run':
      return false;
    case 'accept-as-is':
      return reason !== 'review-input-too-large';
    case 'retry-same-worker':
    case 'restore-backup':
      return stepReadsNone || reason === 'apply-partial' || reason === 'apply-conflict';
    default:
      return stepReadsNone;
  }
}

/**
 * Whether typed words would reach no step on this halt: its chosen action reads none, or every way
 * on reads none. End run reads no words either, so a halt it alone answers keeps them.
 */
function haltLeavesWordsUnread(issue: RecoveryIssue, stepReadsNone: boolean): boolean {
  if (issue.status === 'applying') {
    const chosen = issue.selectedAction;
    return chosen !== undefined && leavesWordsUnread(issue.reason, chosen, stepReadsNone);
  }
  const onward = issue.availableActions.filter((action) => action !== 'end-run');
  return (
    onward.length > 0 &&
    onward.every((action) => leavesWordsUnread(issue.reason, action, stepReadsNone))
  );
}

/** The refusal of words that would go to a step that reads none: Apply, or a review with no seat. */
export function noWordsRefusal(step: StepRef): string {
  return `Cannot send words to ${step.kind === 'apply' ? 'Apply' : 'the review'}. Clear them.`;
}

/**
 * Whether words typed to continue this run reach no step: the step it picks up at reads none, or
 * its halt answers with no step that reads them.
 */
export function statusLeavesWordsUnread(status: RunStatus): boolean {
  if (status.kind !== 'open') return false;
  const stepReadsNone = stepReadsNoWords(status.resumeAt, status.reviewNone === true);
  return status.stop.on.kind === 'halt'
    ? haltLeavesWordsUnread(status.stop.on.issue, stepReadsNone)
    : stepReadsNone;
}

/** Whether words typed at a park past the last brief reach no step: REVIEW None runs no seat there. */
export function parkLeavesWordsUnread(step: StepRef | null, reviewNone: boolean): boolean {
  return reviewNone && step !== null && step.kind !== 'brief';
}
