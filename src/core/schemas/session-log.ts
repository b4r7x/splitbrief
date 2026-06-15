import { z } from 'zod';
import { PhaseSchema } from './enums.js';
import { TaskIdSchema } from './task.js';
import { StructuredSummarySchema } from './compaction.js';

const SessionLogTimestampSchema = z.union([
  z.string(),
  z.number().transform((value) => String(value)),
]);

export const SessionLogMessageEntrySchema = z.object({
  ts: SessionLogTimestampSchema,
  kind: z.literal('message'),
  role: z.enum(['user', 'assistant']),
  phase: PhaseSchema.optional(),
  text: z.string(),
  interrupted: z.boolean().optional(),
  queuedAt: z.string().optional(),
});
export type SessionLogMessageEntry = z.infer<typeof SessionLogMessageEntrySchema>;

export const SessionLogEventEntrySchema = z.object({
  ts: SessionLogTimestampSchema,
  kind: z.literal('event'),
  type: z.string(),
  taskId: TaskIdSchema.optional(),
  phase: PhaseSchema.optional(),
  data: z.unknown(),
});
export type SessionLogEventEntry = z.infer<typeof SessionLogEventEntrySchema>;

export const SessionLogSummaryEntrySchema = z.object({
  ts: SessionLogTimestampSchema,
  kind: z.literal('summary'),
  text: z.string(),
  summarizedUpTo: SessionLogTimestampSchema,
  summarizedCount: z.number().int().nonnegative().optional(),
  tokenEstimate: z.number().optional(),
  structured: StructuredSummarySchema.optional(),
});
export type SessionLogSummaryEntry = z.infer<typeof SessionLogSummaryEntrySchema>;

export const SessionLogEntrySchema = z.discriminatedUnion('kind', [
  SessionLogMessageEntrySchema,
  SessionLogEventEntrySchema,
  SessionLogSummaryEntrySchema,
]);
export type SessionLogEntry = z.infer<typeof SessionLogEntrySchema>;
