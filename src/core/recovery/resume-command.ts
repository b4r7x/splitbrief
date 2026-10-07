import type { RecoveryIssue, SeatSwapCandidate } from '../schemas/recovery/schemas.js';
import { recoveryActionLabel } from './action-label.js';

/**
 * The one line an operator can paste to carry on from a halt. Only the actions
 * `splitbrief continue` can take name themselves; every other recommendation is
 * a row of the recovery panel, which the same command opens, so the line names
 * that row.
 */
export function formatResumeCommand(sessionId: string, issue: RecoveryIssue): string {
  const flag = continueAction(issue);
  if (flag === undefined) {
    const label = recoveryActionLabel(issue.recommendedAction, issue);
    return `splitbrief continue ${sessionId}, then choose ${label} in the recovery panel`;
  }
  return `splitbrief continue ${sessionId} --action ${flag}`;
}

/** A line that names its action runs headless too; the recovery panel needs the TUI. */
export function continuesHeadless(issue: RecoveryIssue): boolean {
  return continueAction(issue) !== undefined;
}

function continueAction(issue: RecoveryIssue): string | undefined {
  switch (issue.recommendedAction) {
    case 'skip-current-task':
      return 'skip';
    case 'retry-same-worker':
      return 'retry';
    case 'end-run':
      return 'end-run';
    case 'switch-seat': {
      const candidate = issue.switchSeat?.candidates[0];
      return candidate === undefined ? undefined : switchSeatAction(candidate);
    }
    default:
      return undefined;
  }
}

/**
 * The seat grammar `switch-seat:<tool>[:<model>][@<effort>]` the `--action` parser
 * reads back into the same candidate: the model is spelled only when the offer
 * names it, and the `@` word is the variant on a variant-channel tool, else the effort.
 */
function switchSeatAction(candidate: SeatSwapCandidate): string {
  const model = candidate.model === undefined ? '' : `:${candidate.model}`;
  const axis = candidate.variant ?? candidate.effort;
  const effort = axis === undefined ? '' : `@${axis}`;
  return `switch-seat:${candidate.tool}${model}${effort}`;
}
