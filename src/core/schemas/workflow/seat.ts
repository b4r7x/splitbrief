import { z } from 'zod';
import { CREW_SEAT_IDS } from '../../crew/identity.js';
import { SeatAccountCauseSchema } from '../../recovery/account-cause.js';
import { RunnerKindSchema, RecoveryReasonSchema } from '../enums.js';
import { SeatSwapCandidateSchema } from '../recovery/schemas.js';

/**
 * The seat a wait holds, by tool and kind, on the BUILD profile it runs on: the runner the waiting
 * call ran on, or the seat the run continues on when the operator chose Retry at. A continue whose
 * config runs that seat on neither this tool nor the runner whose limit the wait waits out does
 * not wait.
 */
export const HeldSeatSchema = z.object({
  tool: z.string(),
  kind: RunnerKindSchema,
  profile: z.string().optional(),
});
export type HeldSeat = z.infer<typeof HeldSeatSchema>;

/**
 * A seat waits for a reset; the runner the halted call ran on, by id, and the seat the wait holds,
 * unless an older state kept none.
 */
export const SeatWaitSchema = z.object({
  seat: z.enum(CREW_SEAT_IDS),
  resetAt: z.string(),
  tool: z.string().optional(),
  kind: RunnerKindSchema.optional(),
  holds: HeldSeatSchema.optional(),
});
export type SeatWait = z.infer<typeof SeatWaitSchema>;

/** A seat moved for a recovery reason, or because the crew changed while the run was stopped. */
export const SeatSwitchCauseSchema = RecoveryReasonSchema.or(z.literal('crew-changed'));
export type SeatSwitchCause = z.infer<typeof SeatSwitchCauseSchema>;

export const SeatSwitchRecordSchema = z.object({
  switchId: z.string().optional(),
  seat: z.enum(CREW_SEAT_IDS),
  from: z.string(),
  to: z.string(),
  fromSeat: SeatSwapCandidateSchema.optional(),
  toSeat: SeatSwapCandidateSchema.optional(),
  cause: RecoveryReasonSchema,
  accountCause: SeatAccountCauseSchema.optional(),
  headline: z.string().optional(),
  auto: z.boolean(),
  configRevision: z.string(),
  ts: z.string(),
});

export type SeatSwitchRecord = z.infer<typeof SeatSwitchRecordSchema>;
