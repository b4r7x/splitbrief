import type { RecoveryAction, RecoveryReason } from '../schemas/enums.js';
import type { SwitchSeatOffer } from '../schemas/recovery/schemas.js';
import { CREW_SEAT_LABELS, type CrewSeatId, type SeatLineSpan } from '../crew/identity.js';
import { formatResetAt } from './reset-clock.js';

const RESET_PREFIX = 'resets ';

export interface RecoveryActionChoiceContext {
  reason?: RecoveryReason | undefined;
  switchSeat?: SwitchSeatOffer | undefined;
  /** The seat the halt stopped, where no offer names it — a recovery event carries only this. */
  seat?: CrewSeatId | undefined;
  /** The seat a retry re-issues when the halt names no brief; absent when it replays one. */
  seatRetry?: CrewSeatId | undefined;
  resetAt?: string | undefined;
}

/**
 * The words a person reads for an action: the recovery menu, the transcript and the resume
 * line. Machine action names stay in the action channel.
 */
export function recoveryActionParts(
  action: RecoveryAction,
  context: RecoveryActionChoiceContext = {},
): readonly SeatLineSpan[] {
  switch (action) {
    case 'retry-same-worker':
      if (context.reason === 'required-checks-unrunnable')
        return [{ text: 'Run the checks again' }];
      return context.seatRetry === undefined
        ? [{ text: 'Try again' }]
        : [
            { text: 'Try again with ' },
            { text: CREW_SEAT_LABELS[context.seatRetry], seat: context.seatRetry },
          ];
    case 'restore-backup':
      return [{ text: 'Restore backup' }];
    case 'retry-later': {
      const reset = formatResetAt(context.resetAt);
      return [
        {
          text:
            reset === undefined ? 'Retry later' : `Retry at ${reset.slice(RESET_PREFIX.length)}`,
        },
      ];
    }
    case 'switch-seat': {
      // The seat is the one that halted; a label that cannot name it names no seat at all.
      const seat = context.switchSeat?.seat ?? context.seat;
      return seat === undefined
        ? [{ text: 'Change tool' }]
        : [{ text: 'Change ' }, { text: CREW_SEAT_LABELS[seat], seat }, { text: ' tool' }];
    }
    case 'revise':
      return [
        {
          text:
            context.reason === 'review-failed'
              ? 'Fix again · add a note, grant one more fix cycle'
              : 'Send a correction',
        },
      ];
    case 'accept-as-is':
      return [
        {
          text:
            context.reason === 'review-input-too-large'
              ? 'Skip review with a note'
              : 'Accept as is',
        },
      ];
    case 'continue':
      return [{ text: 'Continue' }];
    case 'skip-current-task':
      return [{ text: 'Skip task' }];
    case 'end-run':
      return [{ text: 'End run' }];
  }
}

export function recoveryActionLabel(
  action: RecoveryAction,
  context: RecoveryActionChoiceContext = {},
): string {
  return recoveryActionParts(action, context)
    .map((span) => span.text)
    .join('');
}
