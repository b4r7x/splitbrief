import { z } from 'zod';
import { SummarySchema } from './summary.js';

const SessionBaseSchema = z.object({
  id: z.string(),
  feature: z.string(),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
  stateVersion: z.number(),
});

export const SessionSchema = z.discriminatedUnion('status', [
  SessionBaseSchema.extend({ status: z.literal('complete'), summary: SummarySchema }),
  SessionBaseSchema.extend({ status: z.literal('interrupted'), summary: SummarySchema.nullable() }),
  SessionBaseSchema.extend({ status: z.literal('failed'), summary: SummarySchema.nullable() }),
]);
export type Session = z.infer<typeof SessionSchema>;
