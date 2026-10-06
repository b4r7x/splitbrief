import { PICKER_ROLE_SEAT_IDS } from '../../../../core/runners/seat-roles.js';
import type { Phase } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { SeatProtocolError } from '../../../runners/typed-output.js';
import type { RecoveryBuilderBase } from './issue.js';
import { compactFacts, createRecoveryIssue } from './issue.js';
import { chooseRecommended, haltActions } from './actions.js';
import { switchSeatOffer, type SeatSwapContext } from './task.js';

export interface SeatProtocolRecoveryOptions extends RecoveryBuilderBase {
  error: SeatProtocolError;
  phase: Phase;
  seatSwap?: SeatSwapContext | undefined;
}

/**
 * A seat answered twice without matching its typed contract. The seat can be
 * re-issued, moved to another detected tool, or the run stopped on it; the
 * answer belongs to no brief, so no task action is offered.
 */
export function buildSeatProtocolErrorRecoveryIssue(
  opts: SeatProtocolRecoveryOptions,
): RecoveryIssue {
  const reason = 'seat-protocol-error';
  const offer = switchSeatOffer(opts.seatSwap);
  const actions = haltActions(reason, [
    'retry-same-worker',
    offer === undefined ? undefined : 'switch-seat',
    'end-run',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    seat: PICKER_ROLE_SEAT_IDS[opts.error.data.seat],
    reason,
    phase: opts.phase,
    task: undefined,
    files: [],
    affectedTaskIds: [],
    message: opts.error.message,
    details: [opts.error.data.errors],
    ...(offer !== undefined && { switchSeat: offer }),
    facts: compactFacts({
      transport: opts.error.data.transport,
      attempts: String(opts.error.data.attempts),
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}
