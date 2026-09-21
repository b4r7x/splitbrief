import { z } from 'zod';
import { PhaseSchema, WorkflowModeSchema } from './enums.js';
import { StopKindSchema } from './run-step.js';
import { SummarySchema } from './summary.js';
import { isRecord } from '../../utils/type-guards.js';

const LEGACY_OPEN_STATUSES = ['interrupted', 'failed', 'cancelled'];

/** Runs written before run status landed spelled every open stop as its exit path. */
function mapLegacyStatus(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const status = value.status;
  if (typeof status !== 'string' || !LEGACY_OPEN_STATUSES.includes(status)) return value;
  return { ...value, status: 'open', ...(status === 'failed' && { stop: 'failed' }) };
}

const SessionBaseSchema = z.object({
  id: z.string(),
  feature: z.string(),
  startedAt: z.number(),
  completedAt: z.number().nullable(),
  stateVersion: z.number(),
  phase: PhaseSchema.optional(),
  mode: WorkflowModeSchema.optional(),
  stop: StopKindSchema.optional(),
});

const SessionCoreSchema = z.discriminatedUnion('status', [
  SessionBaseSchema.extend({ status: z.literal('complete'), summary: SummarySchema }),
  SessionBaseSchema.extend({ status: z.literal('open'), summary: SummarySchema.nullable() }),
  SessionBaseSchema.extend({ status: z.literal('ended'), summary: SummarySchema.nullable() }),
]);

export const SessionSchema = z.preprocess(mapLegacyStatus, SessionCoreSchema);
export type Session = z.infer<typeof SessionSchema>;
