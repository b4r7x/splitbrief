import type { RecoveryAction, RecoveryReason } from '../schemas/enums.js';
import type { RecoveryFact, SwitchSeatOffer } from '../schemas/recovery/schemas.js';
import { recoveryFactString } from '../schemas/recovery/facts.js';
import { CREW_SEAT_LABELS, type CrewSeatId } from '../crew/identity.js';

export interface RecoveryActionChoiceContext {
  reason?: RecoveryReason | undefined;
  facts?: Record<string, RecoveryFact> | undefined;
  switchSeat?: SwitchSeatOffer | undefined;
  /** The seat the halt stopped, where no offer names it — a recovery event carries only this. */
  seat?: CrewSeatId | undefined;
  /** The seat a retry re-issues when the halt names no brief; absent when it replays one. */
  seatRetry?: CrewSeatId | undefined;
}

export function rebaseVerb(context: RecoveryActionChoiceContext): string {
  return context.reason === 'user-edit-conflict' || context.reason === 'approval-promotion-conflict'
    ? 'rebase on your edits'
    : 'split/rebase';
}

/**
 * The words a person reads for an action: the recovery menu, the transcript and the resume
 * line. Machine action names stay in the action channel.
 */
export function recoveryActionLabel(
  action: RecoveryAction,
  context: RecoveryActionChoiceContext = {},
): string {
  switch (action) {
    case 'retry-same-worker':
      return context.seatRetry === undefined
        ? 'Try again'
        : `Try again with ${CREW_SEAT_LABELS[context.seatRetry]}`;
    case 'restore-backup':
      return 'Restore backup';
    case 'route-bigger-worker': {
      const profile = recoveryFactString(context.facts, 'routeBiggerProfile');
      return profile === undefined ? 'Use a bigger worker' : `Use a bigger worker · ${profile}`;
    }
    case 'switch-seat': {
      // The seat is the one that halted; a label that cannot name it names no seat at all.
      const seat = context.switchSeat?.seat ?? context.seat;
      return seat === undefined ? 'Change tool' : `Change ${CREW_SEAT_LABELS[seat]} tool`;
    }
    case 'planner-split-rebase':
      return `Ask planner to ${rebaseVerb(context)}`;
    // An old run's `revise-spec` sends its note to the planning session, as `revise` does.
    case 'revise':
    case 'revise-spec':
      return context.reason === 'review-failed'
        ? 'Fix again · add a note, grant one more fix cycle'
        : 'Send a correction';
    case 'accept-as-is':
      return 'Accept as is';
    case 'continue':
      return 'Continue';
    case 'skip-current-task':
      return 'Skip task';
    case 'pause-run':
      return 'Pause run';
    case 'end-run':
      return 'End run';
  }
}
