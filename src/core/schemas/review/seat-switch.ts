import { z } from 'zod';
import { SeatSwapCandidateSchema } from '../recovery/schemas.js';
import { SeatSwitchCauseSchema, SeatSwitchRecordSchema } from '../workflow/seat.js';

export const ReviewPacketSeatSwitchSchema = SeatSwitchRecordSchema.omit({ ts: true }).extend({
  from: z.union([SeatSwapCandidateSchema, z.string()]),
  to: z.union([SeatSwapCandidateSchema, z.string()]),
  cause: SeatSwitchCauseSchema,
});
