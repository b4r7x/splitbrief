import type { RecoveryAction, RecoveryReason } from '../schemas/enums.js';
import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import type { RunStatus } from '../sessions/run-status.js';

/**
 * Whether words typed with this action on this halt reach no step that reads them. Apply reads no
 * words, so Re-run Apply and Restore backup leave them unread. Accept as is keeps them only as the
 * note of a review skipped as too large; on a failed review only Apply would read that note, and
 * a checkout run closes without Apply. Every other action hands them to the step it runs next.
 */
export function leavesWordsUnread(reason: RecoveryReason, action: RecoveryAction): boolean {
  switch (action) {
    case 'accept-as-is':
      return reason !== 'review-input-too-large';
    case 'retry-same-worker':
    case 'restore-backup':
      return reason === 'apply-partial' || reason === 'apply-conflict';
    default:
      return false;
  }
}

/**
 * Whether typed words would reach no step on this halt: its chosen action reads none, or every way
 * on reads none. End run reads no words either, so a halt it alone answers keeps them.
 */
function haltLeavesWordsUnread(issue: RecoveryIssue): boolean {
  if (issue.status === 'applying') {
    const chosen = issue.selectedAction;
    return chosen !== undefined && leavesWordsUnread(issue.reason, chosen);
  }
  const onward = issue.availableActions.filter((action) => action !== 'end-run');
  return onward.length > 0 && onward.every((action) => leavesWordsUnread(issue.reason, action));
}

/** Whether words typed to continue this run reach no step: at its halt, or at Apply with no halt. */
export function statusLeavesWordsUnread(status: RunStatus): boolean {
  if (status.kind !== 'open') return false;
  return status.stop.on.kind === 'halt'
    ? haltLeavesWordsUnread(status.stop.on.issue)
    : status.resumeAt.kind === 'apply';
}
