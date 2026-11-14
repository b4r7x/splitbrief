import type { CrewSeatId } from '../../../core/crew/identity.js';
import type { PlannerTierRole } from '../../../core/runners/seat-roles.js';
import type { SeatWait } from '../../../core/schemas/workflow/seat.js';
import type { EngineEventOf } from '../../events/types.js';
import type { BusContext } from './notice.js';

export function publishSeatWaitStarted(ctx: BusContext, wait: SeatWait, tool: string): void {
  ctx.bus.publish({
    type: 'seat_wait_started',
    ts: Date.now(),
    phase: ctx.phase,
    seat: wait.seat,
    resetAt: wait.resetAt,
    tool,
    wait,
  });
}

export function publishSeatWaitEnded(ctx: BusContext, seat: CrewSeatId, kept?: true): void {
  ctx.bus.publish({
    type: 'seat_wait_ended',
    ts: Date.now(),
    phase: ctx.phase,
    seat,
    ...(kept !== undefined && { kept }),
  });
}

export function publishSeatSwitched(
  ctx: BusContext,
  opts: Pick<
    EngineEventOf<'seat_switched'>,
    | 'switchId'
    | 'seat'
    | 'from'
    | 'to'
    | 'cause'
    | 'auto'
    | 'configRevision'
    | 'accountCause'
    | 'headline'
  >,
): void {
  ctx.bus.publish({ type: 'seat_switched', ts: Date.now(), phase: ctx.phase, ...opts });
}

export function publishSeatRetry(
  ctx: BusContext,
  opts: { seat: CrewSeatId; attempt: number; delayMs: number },
): void {
  ctx.bus.publish({ type: 'seat_retry', ts: Date.now(), phase: ctx.phase, ...opts });
}

/** A refused first answer that the seat is asked again for: no row, the reasons stay in the log. */
export function publishSeatAnswerRefused(
  ctx: BusContext,
  seat: PlannerTierRole,
  reasons: readonly string[],
): void {
  ctx.bus.publish({
    type: 'seat_answer_refused',
    ts: Date.now(),
    phase: ctx.phase,
    seat,
    reasons: [...reasons],
  });
}
