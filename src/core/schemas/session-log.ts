import { z } from 'zod';
import { PhaseSchema } from './enums.js';
import { TaskIdSchema } from './task.js';

export const SessionLogMessageEntrySchema = z.object({
  ts: z.string(),
  kind: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  phase: PhaseSchema.optional(),
  text: z.string(),
  interrupted: z.boolean().optional(),
  queuedAt: z.string().optional(),
  drainedAt: z.string().optional(),
});
export type SessionLogMessageEntry = z.infer<typeof SessionLogMessageEntrySchema>;

export const SessionLogEventEntrySchema = z.object({
  ts: z.string(),
  kind: z.literal('event'),
  type: z.string(),
  taskId: TaskIdSchema.optional(),
  phase: PhaseSchema.optional(),
  data: z.unknown(),
});
export type SessionLogEventEntry = z.infer<typeof SessionLogEventEntrySchema>;

export const SessionLogEntrySchema = z.discriminatedUnion('kind', [
  SessionLogMessageEntrySchema,
  SessionLogEventEntrySchema,
]);
export type SessionLogEntry = z.infer<typeof SessionLogEntrySchema>;
