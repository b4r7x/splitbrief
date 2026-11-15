import { z } from 'zod';
import { TaskIdSchema } from '../../../core/schemas/task.js';
import { SeatSwitchCauseSchema, SeatWaitSchema } from '../../../core/schemas/workflow/seat.js';
import { SeatSwapCandidateSchema } from '../../../core/schemas/recovery/schemas.js';
import { CREW_SEAT_IDS } from '../../../core/crew/identity.js';
import { SeatAccountCauseSchema } from '../../../core/recovery/account-cause.js';
import { phaseEvent } from './fields.js';

export const SeatEventSchemas = [
  phaseEvent('seat_wait_started').extend({
    seat: z.enum(CREW_SEAT_IDS),
    resetAt: z.string(),
    /** The tool the wait is on, in the catalog's words; absent on logs written before the field. */
    tool: z.string().optional(),
    /** The wait as `state.json` saved it; absent on logs written before the field. */
    wait: SeatWaitSchema.optional(),
  }),
  phaseEvent('seat_wait_ended').extend({
    seat: z.enum(CREW_SEAT_IDS),
    /** A stop or a steer cut the live wait, and the saved wait stays for the next continue. */
    kept: z.literal(true).optional(),
  }),
  phaseEvent('seat_switched').extend({
    switchId: z.string().optional(),
    seat: z.enum(CREW_SEAT_IDS),
    from: z.union([SeatSwapCandidateSchema, z.string()]),
    to: z.union([SeatSwapCandidateSchema, z.string()]),
    cause: SeatSwitchCauseSchema,
    accountCause: SeatAccountCauseSchema.optional(),
    headline: z.string().optional(),
    auto: z.boolean(),
    configRevision: z.string(),
  }),
  phaseEvent('seat_retry').extend({
    seat: z.enum(CREW_SEAT_IDS),
    attempt: z.number().int().nonnegative(),
    delayMs: z.number().int().nonnegative(),
  }),
  phaseEvent('no_progress_cut').extend({
    taskId: TaskIdSchema.nullable(),
    seat: z.enum(CREW_SEAT_IDS),
    silentMs: z.number().int().nonnegative(),
  }),
  /** The seat's first answer broke its contract, and the seat is asked again with the reasons. */
  phaseEvent('seat_answer_refused').extend({
    seat: z.enum(['planner', 'reviewer']),
    reasons: z.array(z.string()),
  }),
  phaseEvent('consult_bound_spent'),
] as const;
