import { sameSeatCandidate } from '../../../core/crew/identity.js';
import type { RecoveryAction } from '../../../core/schemas/enums.js';
import type { SeatSwapCandidate } from '../../../core/schemas/recovery/schemas.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import { applyRecoveryAction } from '../../../engine/orchestrator/recovery/actions/apply.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { runResumePolicy } from '../resume/policy.js';
import { nextEntryConfig } from '../run-loop/seat-config.js';
import { seatIn, pickSwappedSeat } from './seat-swap-pick.js';
import { settle } from './settle.js';
import type { PendingRecoveryResult, RecoveryDriverState } from './types.js';

/** Applies the chosen action, or returns `null` when the halt stays on the panel. */
export async function applyAction(
  driver: RecoveryDriverState,
  action: RecoveryAction,
  comment?: UserMessageInput,
  steer?: UserMessageInput,
): Promise<PendingRecoveryResult | null> {
  const { issue, state, controller, prepared, configOfRun } = driver;
  if (action === 'switch-seat') {
    const offer = issue.switchSeat;
    const offered = offer?.candidates[0];
    if (offer === undefined || offered === undefined) {
      feedbackStore.setMessage('No other tool is offered for this seat.');
      return null;
    }
    const profile = offer.seat === 'build' ? issue.selectedImplementerProfile : undefined;
    const configured = seatIn(configOfRun, offer.seat, profile);
    // A halt saved before the offer recorded its seat has no `from`: the run's config names it.
    const ranOn = offer.from ?? configured;
    const kept: SeatSwapCandidate[] = [];
    if (ranOn !== undefined) kept.push(ranOn);
    // Preparation names the model a configured seat leaves to its tool: when the prepared
    // seat is the one the call ran on, the configured seat is that seat too.
    const preparedSeat = seatIn(prepared.config, offer.seat, profile);
    if (
      configured !== undefined &&
      preparedSeat !== undefined &&
      ranOn !== undefined &&
      sameSeatCandidate(preparedSeat, ranOn)
    ) {
      kept.push(configured);
    }
    // The picker reads the halt on the view and saves to the profile it names, also when a
    // reopened run replays this switch at once.
    recoveryNoticeStore.open();
    const candidate = await pickSwappedSeat(offer.seat, offered, kept, controller.signal, profile);
    if (controller.signal.aborted || driver.abortedRef.current) return { shouldRun: false, state };
    if (candidate === undefined) return null;
    feedbackStore.reset();
    return {
      shouldRun: true,
      state,
      switchSeat: { candidate, policy: runResumePolicy(prepared.runtime) },
    };
  }

  const { projectDir, sessionId } = prepared.session.ref;
  const result = await applyRecoveryAction({
    projectDir,
    sessionId,
    state,
    action,
    bus: driver.bus,
    config: prepared.config,
    // End run reads no config, so a file that does not load cannot keep the run open.
    ...(action === 'end-run' ? {} : { entryConfig: nextEntryConfig(driver.entry).config }),
    ...(comment === undefined || comment.text.trim() === '' ? {} : { comment }),
  });
  return settle(driver, result, comment, steer);
}
