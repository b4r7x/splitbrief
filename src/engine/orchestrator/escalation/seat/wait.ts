import type { Config } from '../../../../core/schemas/config.js';
import type { SeatWait } from '../../../../core/schemas/workflow/seat.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { seatWaitMoved } from '../../../../core/sessions/held-seat.js';
import { seatWaitToolWord } from '../../../../core/sessions/seat-wait-line.js';
import { loadState } from '../../../../core/state/persistence.js';
import { classifySeatFailure } from '../../../runners/seat-failure.js';
import { type SeatFailure, abortableDelay } from '../../../runners/transient.js';
import { parseUsageLimitReset } from '../../../runners/usage-limit.js';
import { publishSeatWaitStarted, publishSeatWaitEnded } from '../../publish/seat.js';
import { transitionAndSave } from '../../state-ops/transition.js';
import type { WorkflowPersistenceContext } from '../../types.js';

/**
 * The reset a limit failure named, however far away. Only a usage-limit failure
 * can earn a wait; an outcome that names something else, an unreported outcome
 * whose words do not read as a limit, or a reset already past returns undefined
 * and the caller keeps the runner-usage-limit halt with the seat picker.
 */
export function seatResetWaitDeadline(
  failure: SeatFailure,
  now: Date = new Date(),
): Date | undefined {
  const classification = classifySeatFailure({
    message: failure.message,
    ...(failure.outcome !== undefined && { outcome: failure.outcome }),
    source: 'thrown',
  });
  if (classification.class !== 'rate-limited') return undefined;
  const resetAt = parseUsageLimitReset(failure.message, now);
  if (resetAt === null) return undefined;
  const waitMs = resetAt.getTime() - now.getTime();
  if (waitMs <= 0) return undefined;
  return resetAt;
}

/**
 * Park the seat on the persisted wait, publish it, wait until the deadline,
 * then release it. An abort ends the live wait with `kept` and leaves
 * `state.seatWait` in place, so a resume reads the deadline back and keeps
 * waiting before the task continues.
 */
export async function waitForSeatReset(
  input: Readonly<{
    ref: WorkflowPersistenceContext;
    state: WorkflowState;
    wait: SeatWait;
    signal?: AbortSignal | undefined;
  }>,
): Promise<WorkflowState> {
  const base = loadState(input.ref) ?? input.state;
  let state = transitionAndSave(input.ref, base, { type: 'SET_SEAT_WAIT', wait: input.wait });
  publishSeatWaitStarted(
    { bus: input.ref.bus, phase: state.phase },
    input.wait,
    seatWaitToolWord(state, input.wait),
  );
  try {
    await abortableDelay(new Date(input.wait.resetAt).getTime() - Date.now(), input.signal);
  } catch (error) {
    publishSeatWaitEnded({ bus: input.ref.bus, phase: state.phase }, input.wait.seat, true);
    throw error;
  }
  publishSeatWaitEnded({ bus: input.ref.bus, phase: state.phase }, input.wait.seat);
  state = transitionAndSave(input.ref, state, { type: 'CLEAR_SEAT_WAIT' });
  return state;
}

/**
 * A persisted wait is honored on re-entry: a deadline still in the future is
 * waited for before the task continues, one already past is just released, and
 * so is one whose seat this entry's config runs on a tool that is neither the
 * seat the wait holds nor the runner whose limit it waits out.
 */
export async function resumeSeatWait(
  input: Readonly<{
    ref: WorkflowPersistenceContext;
    state: WorkflowState;
    config: Config;
    signal?: AbortSignal | undefined;
  }>,
): Promise<WorkflowState> {
  const wait = input.state.seatWait;
  if (wait === undefined) return input.state;
  const deadline = new Date(wait.resetAt);
  const moved = seatWaitMoved(wait, input.config);
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now() || moved) {
    publishSeatWaitEnded({ bus: input.ref.bus, phase: input.state.phase }, wait.seat);
    return transitionAndSave(input.ref, input.state, { type: 'CLEAR_SEAT_WAIT' });
  }
  return waitForSeatReset({
    ref: input.ref,
    state: input.state,
    wait,
    ...(input.signal !== undefined && { signal: input.signal }),
  });
}
