import type { RecoveryAction } from '../schemas/enums.js';
import type { RecoveryIssue } from '../schemas/recovery/schemas.js';
import { recoveryFactString } from '../schemas/recovery/facts.js';
import { haltOf } from './halt.js';

/**
 * What an empty reply to a question with no default says: the seat that reads the answer decides,
 * the brief's implementer on a consult question and the next review on a review question.
 */
export const DECIDE_YOURSELF_ANSWER = 'Decide this yourself.';

/** The step a halt takes by itself after Decide for me, and the answer a question takes with it. */
export type DecidedRecovery = Readonly<{ action: RecoveryAction; answer?: string }>;

/**
 * The step the run takes in place of asking, once the user chose Decide for me: the planner's
 * `cannot` skips the brief or ends the run as the planner named, a question nobody answered runs
 * the brief again for its implementer to decide or the review again for its reviewer to decide,
 * and a seat down waits for its reset. Undefined when only the user can choose: the plan card, a
 * protected write, an Apply conflict, a failed review with no `cannot` and no question.
 */
export function decidedRecovery(issue: RecoveryIssue): DecidedRecovery | undefined {
  const decided = decidedStep(issue);
  return decided !== undefined && issue.availableActions.includes(decided.action)
    ? decided
    : undefined;
}

function decidedStep(issue: RecoveryIssue): DecidedRecovery | undefined {
  const cannot = recoveryFactString(issue.facts, 'cannot') !== undefined;
  if (issue.reason === 'retry-exhausted') {
    if (cannot)
      return {
        action:
          recoveryFactString(issue.facts, 'cannotNext') === 'end-run'
            ? 'end-run'
            : 'skip-current-task',
      };
    if (recoveryFactString(issue.facts, 'question') !== undefined)
      return { action: 'retry-same-worker', answer: DECIDE_YOURSELF_ANSWER };
    return undefined;
  }
  if (issue.reason === 'review-failed') {
    if (cannot) return { action: 'end-run' };
    // `revise` keeps the question pending; asked again after the choice, it takes DECIDE_YOURSELF_ANSWER.
    if (recoveryFactString(issue.facts, 'question') !== undefined) return { action: 'revise' };
    return undefined;
  }
  if (haltOf(issue.reason) === 'seat-down' && issue.switchSeat?.auto === undefined)
    return { action: 'retry-later' };
  return undefined;
}
