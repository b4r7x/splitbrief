import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import {
  type RecoveryActionChoiceContext,
  recoveryActionLabel,
  recoveryActionParts,
} from '../../../core/recovery/action-label.js';
import { decidedRecovery } from '../../../core/recovery/decide.js';
import { haltOf } from '../../../core/recovery/halt.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import { recoveryFactString } from '../../../core/schemas/recovery/facts.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { isSeatLevelRetry } from '../../../engine/orchestrator/recovery/actions/retry.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';

const REVIEW_FAILED_REVISE_CONSEQUENCE = 'sends your note to the reviewer';

function applyRecoveryConsequence(
  action: RecoveryAction,
  reason: RecoveryActionChoiceContext['reason'],
): string | undefined {
  if (reason !== 'apply-conflict' && reason !== 'apply-partial') return undefined;
  if (action === 'restore-backup' && reason === 'apply-partial')
    return 'puts back the files Apply replaced and removes the ones it created';
  if (action !== 'retry-same-worker') return undefined;
  return reason === 'apply-conflict'
    ? 'after you resolve the files in the workspace'
    : 'writes the files still missing';
}

function recoveryMenuContext(
  issue: RecoveryIssue,
  reviewNone: boolean,
): RecoveryActionChoiceContext {
  return {
    reviewNone,
    reason: issue.reason,
    switchSeat: issue.switchSeat,
    seat: issue.seat,
    resetAt: issue.resetAt,
    haltedTool: recoveryFactString(issue.facts, 'tool'),
  };
}

/** The words of an action's menu row without its consequence, as a byline names the choice. */
export function recoveryMenuActionLabel(
  action: RecoveryAction,
  issue: RecoveryIssue,
  reviewNone: boolean,
): string {
  return recoveryActionLabel(action, recoveryMenuContext(issue, reviewNone));
}

/**
 * A menu row's words. A swap says what it runs again, as the applier decides it
 * (`isSeatLevelRetry`): the step the halted seat was on, else the brief the halt
 * names. So does a retry after a PLAN or REVIEW halt on a brief: "Try again"
 * alone reads as retrying the call that stopped. A *Seat down* halt on BUILD or
 * PLAN parks its brief (`raiseBriefHalt`), so that brief continues on the files
 * it kept; after any other halt the brief starts again. On a short panel the
 * facts above the rows are what drops.
 */
export function recoveryMenuParts(
  action: RecoveryAction,
  issue: RecoveryIssue,
  briefFinished: boolean,
  reviewNone: boolean,
): ConversationRowSegment[] {
  const label = recoveryActionParts(action, recoveryMenuContext(issue, reviewNone)).map(
    (part): ConversationRowSegment => ({
      text: part.text,
      tone: part.seat === undefined ? 'text' : CREW_SEAT_ROLES[part.seat],
    }),
  );
  const consequence =
    action === 'end-run' && briefFinished
      ? 'closes this run, keeps its changes'
      : recoveryMenuConsequence(action, issue, reviewNone);
  return consequence === undefined
    ? label
    : [...label, { text: SOFT_SEP, tone: 'textDim' }, { text: consequence, tone: 'textDim' }];
}

const DECIDED_STEP_CONSEQUENCE: Partial<Record<RecoveryAction, string>> = {
  'skip-current-task': 'skips this brief',
  'end-run': 'closes this run',
  'retry-same-worker': 'lets the implementer decide',
  revise: 'lets the next review decide',
};

function recoveryMenuConsequence(
  action: RecoveryAction,
  issue: RecoveryIssue,
  reviewNone: boolean,
): string | undefined {
  if (action === 'accept-as-is')
    return issue.reason === 'review-input-too-large'
      ? 'accepts the result'
      : 'records the blockers';
  if (action === 'decide-for-me') {
    const decided = decidedRecovery(issue);
    return decided === undefined ? undefined : DECIDED_STEP_CONSEQUENCE[decided.action];
  }
  if (action === 'retry-same-worker' || action === 'restore-backup') {
    const apply = applyRecoveryConsequence(action, issue.reason);
    if (apply !== undefined) return apply;
  }
  if (action === 'revise')
    return issue.reason === 'review-failed' && !reviewNone
      ? REVIEW_FAILED_REVISE_CONSEQUENCE
      : undefined;
  const seatLevel = isSeatLevelRetry(issue);
  const says =
    action === 'switch-seat' ||
    (action === 'retry-same-worker' &&
      !seatLevel &&
      (issue.seat === 'plan' || issue.seat === 'review'));
  if (!says) return undefined;
  if (!seatLevel)
    return haltOf(issue.reason) === 'seat-down' && issue.seat !== 'review'
      ? 'continues this brief'
      : 'restarts this brief';
  return issue.phase === 'final-review' ? 'runs the review again' : 'runs this step again';
}
